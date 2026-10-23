import { GitHubMergeCoordinator, type MergeCoordinator } from './merge-coordinator.js';
import { lokiPolicy } from './verification.js';
import { execGitCommand } from '@automaker/git-utils';
import type { ArgusTaskState, RecoverySnapshot } from './types.js';
import type { GitHubCiObserver, GitHubPullRequest } from './github-ci-observer.js';

export interface LocalRepositoryState {
  currentBranch: string;
  localHead: string;
  remoteHead: string;
  remoteContainsMerge: boolean;
  dirty: boolean;
  localAhead: boolean;
}
export interface LocalSyncResult extends LocalRepositoryState {
  recoveryRef: string | null;
  recoveryReason: string | null;
  recoveryOriginalHead: string | null;
  recoveryCreatedAt: string | null;
  recoverySnapshots: RecoverySnapshot[];
}
export interface LocalGitAdapter {
  inspect(
    projectPath: string,
    baseBranch: string,
    mergeSha?: string
  ): Promise<LocalRepositoryState>;
  fetchAndInspect(
    projectPath: string,
    baseBranch: string,
    mergeSha?: string
  ): Promise<LocalRepositoryState>;
  synchronize(
    projectPath: string,
    baseBranch: string,
    mergeSha: string,
    taskId: string
  ): Promise<LocalSyncResult>;
}

export class CommandLocalGitAdapter implements LocalGitAdapter {
  async fetchAndInspect(projectPath: string, baseBranch: string, mergeSha?: string) {
    try {
      await execGitCommand(['remote', 'get-url', 'origin'], projectPath);
    } catch {
      throw new Error('GIT_REMOTE_REQUIRED');
    }
    await execGitCommand(['fetch', '--prune', 'origin'], projectPath);
    return this.inspect(projectPath, baseBranch, mergeSha);
  }
  async inspect(
    projectPath: string,
    baseBranch: string,
    mergeSha?: string
  ): Promise<LocalRepositoryState> {
    try {
      await execGitCommand(['remote', 'get-url', 'origin'], projectPath);
    } catch {
      throw new Error('GIT_REMOTE_REQUIRED');
    }
    const currentBranch = (await execGitCommand(['branch', '--show-current'], projectPath)).trim();
    const localHead = (await execGitCommand(['rev-parse', 'HEAD'], projectPath)).trim();
    const remoteHead = (
      await execGitCommand(['rev-parse', `origin/${baseBranch}`], projectPath)
    ).trim();
    const dirty = Boolean(
      (
        await execGitCommand(
          ['status', '--porcelain', '--', '.', ':(top,exclude).automaker'],
          projectPath
        )
      ).trim()
    );
    const localAhead = !(await isAncestor(projectPath, localHead, remoteHead));
    const remoteContainsMerge = mergeSha
      ? await isAncestor(projectPath, mergeSha, remoteHead)
      : false;
    return { currentBranch, localHead, remoteHead, remoteContainsMerge, dirty, localAhead };
  }

  async synchronize(projectPath: string, baseBranch: string, mergeSha: string, taskId: string) {
    if ((await execGitCommand(['ls-files', '--', '.automaker'], projectPath)).trim())
      throw new Error('ARGUS_STATE_TRACKED_IN_GIT');
    await execGitCommand(['fetch', '--prune', 'origin'], projectPath);
    let state = await this.inspect(projectPath, baseBranch, mergeSha);
    if (!state.remoteContainsMerge) throw new Error('REMOTE_MERGE_NOT_FOUND');
    const recoverySnapshots: RecoverySnapshot[] = [];
    let recoveryRef: string | null = null,
      recoveryReason: string | null = null;
    const recoveryOriginalHead = state.localHead;
    const recoveryCreatedAt = new Date().toISOString();
    const stamp = recoveryCreatedAt.replace(/[-:.TZ]/g, '').slice(0, 14);
    if (state.dirty) {
      const label = `automaker-recovery/${stamp}/${taskId}`;
      await execGitCommand(
        ['stash', 'push', '-u', '-m', label, '--', '.', ':(top,exclude).automaker'],
        projectPath
      );
      const stashSha = (await execGitCommand(['rev-parse', 'stash@{0}'], projectPath)).trim();
      const ref = `refs/automaker/recovery/${stamp}-dirty-${stashSha.slice(0, 8)}`;
      await execGitCommand(['update-ref', ref, stashSha], projectPath);
      recoverySnapshots.push({
        kind: 'dirty-worktree',
        ref,
        objectSha: stashSha,
        originalHead: recoveryOriginalHead,
        createdAt: recoveryCreatedAt,
      });
      recoveryRef = ref;
      recoveryReason = 'LOCAL_DIRTY_RECOVERY_CREATED';
      state = await this.inspect(projectPath, baseBranch, mergeSha);
    }
    if (state.localAhead) {
      const ref = `refs/automaker/recovery/${stamp}-${state.localHead.slice(0, 8)}`;
      await execGitCommand(['update-ref', ref, state.localHead], projectPath);
      recoverySnapshots.push({
        kind: 'local-divergence',
        ref,
        objectSha: state.localHead,
        originalHead: state.localHead,
        createdAt: recoveryCreatedAt,
      });
      recoveryRef = recoveryRef ? `${recoveryRef},${ref}` : ref;
      recoveryReason = 'LOCAL_DIVERGENCE_RECOVERY_CREATED';
    }
    if (state.currentBranch !== baseBranch)
      await execGitCommand(['checkout', baseBranch], projectPath);
    const refreshed = await this.inspect(projectPath, baseBranch, mergeSha);
    if (await isAncestor(projectPath, refreshed.localHead, refreshed.remoteHead))
      await execGitCommand(['merge', '--ff-only', `origin/${baseBranch}`], projectPath);
    else {
      if (!recoveryRef) throw new Error('LOCAL_SYNC_FAILED');
      await execGitCommand(['reset', '--hard', `origin/${baseBranch}`], projectPath);
    }
    const final = await this.inspect(projectPath, baseBranch, mergeSha);
    if (final.localHead !== final.remoteHead || !final.remoteContainsMerge)
      throw new Error('LOCAL_SYNC_FAILED');
    return {
      ...final,
      recoveryRef,
      recoveryReason,
      recoveryOriginalHead: recoveryRef ? recoveryOriginalHead : null,
      recoveryCreatedAt: recoveryRef ? recoveryCreatedAt : null,
      recoverySnapshots,
    };
  }
}

async function isAncestor(projectPath: string, ancestor: string, descendant: string) {
  try {
    await execGitCommand(['merge-base', '--is-ancestor', ancestor, descendant], projectPath);
    return true;
  } catch {
    return false;
  }
}

export class GitIntegrationService {
  constructor(
    private github: GitHubCiObserver,
    private local: LocalGitAdapter = new CommandLocalGitAdapter(),
    readonly coordinator: MergeCoordinator = new GitHubMergeCoordinator(github)
  ) {}
  refreshPullRequest(repository: string, number: number) {
    return this.github.getPullRequest(repository, number);
  }
  assertMergeGate(task: ArgusTaskState, pr: GitHubPullRequest, deploymentDisabled: boolean) {
    const valid =
      ['merge-ready', 'merge-intent', 'merging'].includes(task.phase) &&
      (pr.state === 'OPEN' || pr.merged) &&
      pr.repository.toLowerCase() === task.repository?.toLowerCase() &&
      pr.number === task.prNumber &&
      pr.headSha === task.prHeadSha &&
      task.reviewedHeadSha === task.prHeadSha &&
      task.ciHeadSha === task.prHeadSha &&
      task.ciState === 'success' &&
      task.reviewVerdict === 'approve' &&
      pr.baseBranch === task.baseBranch &&
      deploymentDisabled &&
      (!(lokiPolicy().enabled || lokiPolicy().requiredForMerge || task.lokiEvidence) ||
        (task.lokiEvidence?.verdict === 'VERIFIED' &&
          task.lokiEvidence.headSha === pr.headSha &&
          task.lokiEvidence.baseSha === (task.humanMergeGate?.baseSha || pr.baseSha) &&
          task.lokiEvidence.repository.toLowerCase() === pr.repository.toLowerCase() &&
          task.lokiEvidence.prNumber === pr.number)) &&
      !task.blockedReason &&
      !task.lease;
    if (!valid)
      throw new Error(
        pr.headSha !== task.prHeadSha ? 'MERGE_GATE_STALE_HEAD' : 'MERGE_GATE_REJECTED'
      );
  }
  /** Compatibility deny boundary: no autonomous caller can initiate a remote merge. */
  async mergePullRequest(_task: ArgusTaskState): Promise<never> {
    throw new MergeOperationError('ARGUS_AUTOMATIC_MERGE_FORBIDDEN');
  }
  fetchAuthoritativeBase(path: string, base: string, merge?: string) {
    return this.local.fetchAndInspect(path, base, merge);
  }
  syncCanonicalCheckout(path: string, task: ArgusTaskState) {
    return this.local.synchronize(path, task.baseBranch!, task.mergeCommitSha!, task.taskId);
  }
}

export class MergeOperationError extends Error {
  constructor(
    readonly code:
      | 'ARGUS_AUTOMATIC_MERGE_FORBIDDEN'
      | 'MERGE_OUTCOME_UNKNOWN'
      | 'MERGE_CONFLICT'
      | 'MERGE_NOT_PERMITTED'
      | 'MERGE_REJECTED'
  ) {
    super(code);
  }
}

export function assertDoneInvariant(
  task: ArgusTaskState,
  repo: LocalRepositoryState,
  pr: GitHubPullRequest
) {
  if (
    !pr.merged ||
    pr.repository.toLowerCase() !== task.repository?.toLowerCase() ||
    pr.number !== task.prNumber ||
    pr.baseBranch !== task.baseBranch ||
    pr.headSha !== task.prHeadSha ||
    task.reviewVerdict !== 'approve' ||
    !task.externalMerge ||
    task.externalMerge.repository.toLowerCase() !== pr.repository.toLowerCase() ||
    task.externalMerge.prNumber !== pr.number ||
    task.externalMerge.headSha !== pr.headSha ||
    task.externalMerge.baseBranch !== pr.baseBranch ||
    task.externalMerge.mergeCommitSha !== pr.mergeCommitSha ||
    !task.mergeCommitSha ||
    pr.mergeCommitSha !== task.mergeCommitSha ||
    !repo.remoteContainsMerge ||
    repo.localHead !== repo.remoteHead ||
    task.localSyncedSha !== repo.remoteHead ||
    task.reviewedHeadSha !== task.prHeadSha ||
    task.ciHeadSha !== task.prHeadSha ||
    task.ciState !== 'success' ||
    task.lease ||
    task.blockedReason
  )
    throw new Error('DONE_INVARIANT_FAILED');
  return true;
}

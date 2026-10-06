import crypto from 'crypto';
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
    const dirty = Boolean((await execGitCommand(['status', '--porcelain'], projectPath)).trim());
    const localAhead = !(await isAncestor(projectPath, localHead, remoteHead));
    const remoteContainsMerge = mergeSha
      ? await isAncestor(projectPath, mergeSha, remoteHead)
      : false;
    return { currentBranch, localHead, remoteHead, remoteContainsMerge, dirty, localAhead };
  }

  async synchronize(projectPath: string, baseBranch: string, mergeSha: string, taskId: string) {
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
      await execGitCommand(['stash', 'push', '-u', '-m', label], projectPath);
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
    private local: LocalGitAdapter = new CommandLocalGitAdapter()
  ) {}
  refreshPullRequest(repository: string, number: number) {
    return this.github.getPullRequest(repository, number);
  }
  assertMergeGate(task: ArgusTaskState, pr: GitHubPullRequest, deploymentDisabled: boolean) {
    const valid =
      ['merge-ready', 'merge-intent', 'merging'].includes(task.phase) &&
      pr.state === 'OPEN' &&
      pr.headSha === task.prHeadSha &&
      task.reviewedHeadSha === task.prHeadSha &&
      task.ciHeadSha === task.prHeadSha &&
      task.ciState === 'success' &&
      task.reviewVerdict === 'approve' &&
      pr.baseBranch === task.baseBranch &&
      deploymentDisabled &&
      !task.blockedReason &&
      !task.lease;
    if (!valid)
      throw new Error(
        pr.headSha !== task.prHeadSha ? 'MERGE_GATE_STALE_HEAD' : 'MERGE_GATE_REJECTED'
      );
  }
  async createMergeIntent(task: ArgusTaskState, baseBeforeMergeSha: string) {
    const attemptedAt = new Date().toISOString();
    task.mergeIntent = {
      mergeAttemptId: crypto.randomUUID(),
      prNumber: task.prNumber!,
      expectedHeadSha: task.prHeadSha!,
      baseBranch: task.baseBranch!,
      baseBeforeMergeSha,
      mergeOutcome: 'unknown',
      attemptedAt,
    };
    task.mergeExpectedHeadSha = task.prHeadSha;
    task.mergeAttemptedAt = attemptedAt;
    task.phase = 'merge-intent';
  }
  async mergePullRequest(task: ArgusTaskState) {
    try {
      const result = await this.github.mergePullRequest(
        task.repository!,
        task.prNumber!,
        task.mergeIntent!.expectedHeadSha
      );
      if (!result.merged) throw classifyMergeFailure(result.message || 'MERGE_REJECTED');
      return result;
    } catch (error) {
      if (error instanceof MergeOperationError) throw error;
      throw classifyMergeFailure((error as Error).message || String(error));
    }
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
      | 'MERGE_OUTCOME_UNKNOWN'
      | 'MERGE_CONFLICT'
      | 'MERGE_NOT_PERMITTED'
      | 'MERGE_REJECTED'
  ) {
    super(code);
  }
}

function classifyMergeFailure(message: string): MergeOperationError {
  const value = message.toLowerCase();
  if (/conflict|not mergeable|unmergeable|\b409\b/.test(value))
    return new MergeOperationError('MERGE_CONFLICT');
  if (/permission|forbidden|branch protection|protected branch|\b401\b|\b403\b/.test(value))
    return new MergeOperationError('MERGE_NOT_PERMITTED');
  if (/timeout|timed out|network|socket|econn|enotfound|transport|unknown outcome/.test(value))
    return new MergeOperationError('MERGE_OUTCOME_UNKNOWN');
  return new MergeOperationError('MERGE_REJECTED');
}

export function assertDoneInvariant(
  task: ArgusTaskState,
  repo: LocalRepositoryState,
  pr: GitHubPullRequest
) {
  if (
    !pr.merged ||
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

import crypto from 'crypto';
import { execGitCommand } from '@automaker/git-utils';
import type { ArgusTaskState } from './types.js';
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
}
export interface LocalGitAdapter {
  inspect(
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
    let recoveryRef: string | null = null,
      recoveryReason: string | null = null;
    const recoveryOriginalHead = state.localHead;
    const recoveryCreatedAt = new Date().toISOString();
    const stamp = recoveryCreatedAt.replace(/[-:.TZ]/g, '').slice(0, 14);
    if (state.dirty) {
      const label = `automaker-recovery/${stamp}/${taskId}`;
      await execGitCommand(['stash', 'push', '-u', '-m', label], projectPath);
      recoveryRef = 'stash@{0}';
      recoveryReason = 'LOCAL_DIRTY_RECOVERY_CREATED';
      state = await this.inspect(projectPath, baseBranch, mergeSha);
    }
    if (state.localAhead) {
      const ref = `refs/automaker/recovery/${stamp}-${state.localHead.slice(0, 8)}`;
      await execGitCommand(['update-ref', ref, state.localHead], projectPath);
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
  mergePullRequest(task: ArgusTaskState) {
    return this.github.mergePullRequest(
      task.repository!,
      task.prNumber!,
      task.mergeIntent!.expectedHeadSha
    );
  }
  fetchAuthoritativeBase(path: string, base: string, merge?: string) {
    return this.local.inspect(path, base, merge);
  }
  syncCanonicalCheckout(path: string, task: ArgusTaskState) {
    return this.local.synchronize(path, task.baseBranch!, task.mergeCommitSha!, task.taskId);
  }
}

export function assertDoneInvariant(
  task: ArgusTaskState,
  repo: LocalRepositoryState,
  pr: GitHubPullRequest
) {
  if (
    !pr.merged ||
    !task.mergeCommitSha ||
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

import fs from 'fs/promises';
import path from 'path';
import type { FeatureLoader } from '../feature-loader.js';
import { saveArgusState } from './project-lifecycle.js';
import {
  assertDoneInvariant,
  MergeOperationError,
  type GitIntegrationService,
} from './git-integration-service.js';
import type { ArgusService, ArgusTaskState } from './types.js';
import { SpecRenewalService } from './spec-renewal-service.js';

const locks = new Map<string, Promise<void>>();

export class MilestoneEOrchestrator {
  constructor(
    private argus: ArgusService,
    private features: FeatureLoader,
    private git: GitIntegrationService,
    private specs = new SpecRenewalService(),
    private nextCampaign?: { reconcileProject(path: string): Promise<ArgusTaskState | null> }
  ) {}

  async reconcile(projectPath: string) {
    const previous = locks.get(projectPath) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    const queued = previous.then(() => current);
    locks.set(projectPath, queued);
    await previous;
    try {
      await this.reconcileLocked(projectPath);
    } finally {
      release();
      if (locks.get(projectPath) === queued) locks.delete(projectPath);
    }
  }

  private async reconcileLocked(projectPath: string) {
    const state = await this.argus.getStatus(projectPath),
      task = state?.activeTask;
    if (!state || !task || !task.repository || !task.prNumber || !task.baseBranch) return;
    if (task.phase === 'senior-patch-ready' || task.phase === 'objective-satisfied') return;
    let pr = await this.git.refreshPullRequest(task.repository, task.prNumber);
    if (task.mergeIntent?.mergeOutcome === 'unknown') {
      if (pr.merged) {
        this.event(task, 'MERGE_RECOVERED_AFTER_RESTART');
        await this.confirmMerge(projectPath, task, pr.mergeCommitSha);
      } else if (pr.state !== 'OPEN') return this.block(projectPath, task, 'PR_CLOSED_UNMERGED');
      else if (pr.headSha !== task.mergeIntent.expectedHeadSha)
        return this.stale(projectPath, task, pr.headSha);
      else {
        const policy = await fs.readFile(
          path.join(projectPath, '.automaker', 'argus.yaml'),
          'utf8'
        );
        try {
          this.git.assertMergeGate(task, pr, /deployment:\s*disabled/.test(policy));
        } catch (error) {
          return this.block(projectPath, task, (error as Error).message);
        }
        await this.requestMerge(projectPath, task);
      }
    } else if (task.phase === 'merge-ready') {
      this.event(task, 'MERGE_GATE_CHECK');
      const policy = await fs.readFile(path.join(projectPath, '.automaker', 'argus.yaml'), 'utf8');
      try {
        this.git.assertMergeGate(task, pr, /deployment:\s*disabled/.test(policy));
      } catch (error) {
        this.event(task, 'MERGE_GATE_REJECTED');
        if ((error as Error).message === 'MERGE_GATE_STALE_HEAD')
          return this.stale(projectPath, task, pr.headSha);
        return this.block(projectPath, task, (error as Error).message);
      }
      this.event(task, 'MERGE_GATE_PASSED');
      await this.git.createMergeIntent(task, pr.baseSha);
      this.event(task, 'MERGE_INTENT_CREATED');
      await this.persist(projectPath, task);
      await this.requestMerge(projectPath, task);
    }
    if (!['merged', 'local-sync', 'local-synced', 'done'].includes(task.phase)) return;
    pr = await this.git.refreshPullRequest(task.repository, task.prNumber);
    if (!pr.merged) return this.block(projectPath, task, 'MERGE_OUTCOME_UNKNOWN');
    if (!task.mergeCommitSha) await this.confirmMerge(projectPath, task, pr.mergeCommitSha);
    if (task.phase === 'merged' || task.phase === 'local-sync') {
      task.phase = 'local-sync';
      this.event(task, 'GIT_LOCAL_SYNC_STARTED');
      await this.persist(projectPath, task);
      try {
        const synced = await this.git.syncCanonicalCheckout(projectPath, task);
        Object.assign(task, {
          remoteBaseSha: synced.remoteHead,
          localBaseSha: synced.localHead,
          localSyncedSha: synced.localHead,
          baseHeadAfterMergeSha: synced.remoteHead,
          recoveryRef: synced.recoveryRef,
          recoveryReason: synced.recoveryReason,
          recoveryOriginalHead: synced.recoveryOriginalHead,
          recoveryCreatedAt: synced.recoveryCreatedAt,
          recoverySnapshots: synced.recoverySnapshots,
        });
        if (synced.recoveryRef)
          this.event(task, 'GIT_RECOVERY_SNAPSHOT_CREATED', { ref: synced.recoveryRef });
        this.event(task, 'GIT_FETCH_COMPLETED');
        this.event(task, 'GIT_LOCAL_SYNC_COMPLETED');
        task.phase = 'local-synced';
        await this.persist(projectPath, task);
      } catch (error) {
        return this.block(projectPath, task, (error as Error).message || 'LOCAL_SYNC_FAILED');
      }
    }
    const repo = await this.git.fetchAuthoritativeBase(
      projectPath,
      task.baseBranch,
      task.mergeCommitSha!
    );
    this.event(task, 'DONE_INVARIANT_CHECK');
    try {
      assertDoneInvariant(task, repo, pr);
    } catch {
      return this.block(projectPath, task, 'DONE_INVARIANT_FAILED');
    }
    task.phase = 'done';
    task.nextAction = 'objective-evaluation';
    this.event(task, 'TASK_DONE');
    state.consecutiveSpecRenewalsWithoutCompletedTask = 0;
    await this.persist(projectPath, task, 'verified');
    await this.evaluateObjective(projectPath, task);
  }

  private async requestMerge(projectPath: string, task: ArgusTaskState) {
    task.phase = 'merging';
    this.event(task, 'MERGE_REQUESTED');
    await this.persist(projectPath, task);
    try {
      await this.git.mergePullRequest(task);
    } catch (error) {
      if (error instanceof MergeOperationError && error.code !== 'MERGE_OUTCOME_UNKNOWN') {
        task.mergeIntent!.mergeOutcome = 'failed';
        return this.block(projectPath, task, error.code);
      }
      /* Transport ambiguity: refresh before any retry. */
    }
    const pr = await this.git.refreshPullRequest(task.repository!, task.prNumber!);
    if (pr.merged) return this.confirmMerge(projectPath, task, pr.mergeCommitSha);
    if (pr.headSha !== task.mergeIntent!.expectedHeadSha)
      return this.stale(projectPath, task, pr.headSha);
    task.phase = 'merge-intent';
    task.nextAction = 'reconcile-merge-outcome';
    await this.persist(projectPath, task);
  }
  private async confirmMerge(projectPath: string, task: ArgusTaskState, sha: string | null) {
    if (!sha) return this.block(projectPath, task, 'REMOTE_MERGE_NOT_FOUND');
    task.mergeCommitSha = sha;
    task.mergedSha = sha;
    task.mergedAt = new Date().toISOString();
    task.mergeIntent!.mergeOutcome = 'merged';
    task.phase = 'merged';
    this.event(task, 'MERGE_CONFIRMED');
    await this.persist(projectPath, task);
  }
  private async stale(projectPath: string, task: ArgusTaskState, head: string) {
    task.prHeadSha = head;
    task.ciHeadSha = null;
    task.ciState = 'pending';
    task.reviewedHeadSha = null;
    task.reviewVerdict = null;
    task.reviewFindings = [];
    task.mergeIntent = null;
    task.phase = 'ci-check';
    this.event(task, 'MERGE_GATE_STALE_HEAD');
    await this.persist(projectPath, task);
  }
  private async evaluateObjective(projectPath: string, task: ArgusTaskState) {
    const state = (await this.argus.getStatus(projectPath))!;
    task.phase = 'objective-evaluation';
    this.event(task, 'OBJECTIVE_EVALUATION_STARTED');
    await this.persist(projectPath, task);
    try {
      const evaluation = await this.argus.evaluateObjective(projectPath, {
        task: { id: task.taskId, acceptanceCriteria: task.acceptanceCriteria },
        git: {
          prHeadSha: task.prHeadSha,
          mergeCommitSha: task.mergeCommitSha,
          remoteBaseSha: task.remoteBaseSha,
        },
        ci: { headSha: task.ciHeadSha, state: task.ciState },
        review: { headSha: task.reviewedHeadSha, verdict: task.reviewVerdict },
      });
      task.objectiveEvaluation = evaluation;
      if (evaluation.satisfied) {
        task.phase = 'objective-satisfied';
        this.event(task, 'OBJECTIVE_SATISFIED');
        await this.persist(projectPath, task, 'verified');
        state.autonomy = 'satisfied';
        state.activeTask = null;
        state.phase = 'objective-satisfied';
        state.latestStatus = 'OBJECTIVE_SATISFIED';
        await saveArgusState(projectPath, state);
        return;
      }
      this.event(task, 'OBJECTIVE_GAPS_FOUND');
      task.phase = 'spec-renewal';
      this.event(task, 'SPEC_RENEWAL_STARTED');
      await this.persist(projectPath, task);
      const nextSpec = await this.argus.renewSpecification(projectPath, evaluation);
      await this.specs.renew(projectPath, state, nextSpec, evaluation);
      this.event(task, 'SPEC_RENEWED');
      this.event(task, 'NEXT_CAMPAIGN_STARTED');
      await this.features.update(projectPath, task.featureId, {
        status: 'verified',
        argus: { ...task },
      });
      await this.nextCampaign?.reconcileProject(projectPath);
    } catch (error) {
      await this.block(
        projectPath,
        task,
        (error as Error).message || 'OBJECTIVE_EVALUATION_FAILED'
      );
    }
  }
  private event(task: ArgusTaskState, type: string, details?: Record<string, unknown>) {
    task.lastArgusEvent = type;
    task.events.push({ type, at: new Date().toISOString(), details });
    task.events = task.events.slice(-100);
  }
  private async block(path: string, task: ArgusTaskState, reason: string) {
    task.phase = 'blocked';
    task.blockedReason = reason;
    this.event(task, reason);
    await this.persist(path, task, 'failed');
  }
  private async persist(
    projectPath: string,
    task: ArgusTaskState,
    status: 'review' | 'verified' | 'failed' = 'review'
  ) {
    const state = await this.argus.getStatus(projectPath);
    if (!state) throw new Error('Argus project missing');
    state.activeTask = task;
    state.phase = task.phase;
    state.latestStatus = task.lastArgusEvent;
    await saveArgusState(projectPath, state);
    await this.features.update(projectPath, task.featureId, { status, argus: { ...task } });
  }
}

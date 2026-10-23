import { ArgusBoardProjector } from './board-projector.js';
import { TaskHistoryStore } from './task-history.js';
import fs from 'fs/promises';
import path from 'path';
import type { FeatureLoader } from '../feature-loader.js';
import { saveArgusState } from './project-lifecycle.js';
import { assertDoneInvariant, type GitIntegrationService } from './git-integration-service.js';
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
    projectPath = await fs.realpath(projectPath);
    const previous = locks.get(projectPath) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    const queued = previous.then(() => current);
    locks.set(projectPath, queued);
    await previous;
    try {
      // Observation is read-only remotely. Legacy intents never authorize a retry.
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
    if (
      pr.merged &&
      !task.events.some(
        (event) =>
          event.type === 'EXTERNAL_MERGE_OBSERVED' &&
          event.details?.mergeCommitSha === pr.mergeCommitSha &&
          event.details?.headSha === pr.headSha
      )
    ) {
      this.event(task, 'EXTERNAL_MERGE_OBSERVED', {
        repository: pr.repository,
        prNumber: pr.number,
        headSha: pr.headSha,
        baseBranch: pr.baseBranch,
        mergeCommitSha: pr.mergeCommitSha,
      });
      await this.persist(projectPath, task);
    }
    if (
      pr.repository.toLowerCase() !== task.repository.toLowerCase() ||
      pr.number !== task.prNumber ||
      pr.baseBranch !== task.baseBranch
    )
      return this.block(projectPath, task, 'MERGE_IDENTITY_MISMATCH');
    const pinned = task.humanMergeGate;
    if (
      pinned &&
      (pinned.repository.toLowerCase() !== pr.repository.toLowerCase() ||
        pinned.prNumber !== pr.number ||
        pinned.baseBranch !== pr.baseBranch)
    )
      return this.block(projectPath, task, 'MERGE_IDENTITY_MISMATCH');
    if (
      task.mergeIntent?.mergeOutcome === 'unknown' &&
      (task.mergeIntent.prNumber !== pr.number || task.mergeIntent.baseBranch !== pr.baseBranch)
    )
      return this.block(projectPath, task, 'MERGE_IDENTITY_MISMATCH');
    if (
      ['merge-ready', 'merge-intent', 'merging'].includes(task.phase) ||
      task.mergeIntent?.mergeOutcome === 'unknown'
    ) {
      const expectedHead =
        task.humanMergeGate?.headSha || task.mergeIntent?.expectedHeadSha || task.prHeadSha;
      if (pr.headSha !== expectedHead || pr.headSha !== task.prHeadSha)
        return this.stale(projectPath, task, pr.headSha);
      if (!pr.merged && pr.state !== 'OPEN')
        return this.block(projectPath, task, 'PR_CLOSED_UNMERGED');
      const policy = await fs.readFile(path.join(projectPath, '.automaker', 'argus.yaml'), 'utf8');
      try {
        this.git.assertMergeGate(task, pr, /deployment:\s*disabled/.test(policy));
      } catch (error) {
        return this.block(projectPath, task, (error as Error).message);
      }
      if (pr.merged) {
        if (task.mergeIntent?.mergeOutcome === 'unknown')
          this.event(task, 'MERGE_RECOVERED_AFTER_RESTART');
        await this.confirmMerge(projectPath, task, pr.mergeCommitSha);
        if (task.phase === 'blocked') return;
      } else {
        if (!task.humanMergeGate) {
          task.humanMergeGate = {
            repository: task.repository,
            prNumber: task.prNumber,
            headSha: pr.headSha,
            baseBranch: pr.baseBranch,
            baseSha: pr.baseSha,
            url: pr.url,
            readyAt: new Date().toISOString(),
          };
          this.event(task, 'HUMAN_MERGE_REQUIRED', { ...task.humanMergeGate });
        }
        task.nextAction = 'human-merge-required';
        // Keep merge-ready for compatibility with the existing runner and board lane.
        task.phase = 'merge-ready';
        await this.persist(projectPath, task);
        return;
      }
    }
    if (!['merged', 'local-sync', 'local-synced', 'done'].includes(task.phase)) return;
    pr = await this.git.refreshPullRequest(task.repository, task.prNumber);
    if (!pr.merged) return this.block(projectPath, task, 'MERGE_OUTCOME_UNKNOWN');
    if (
      pr.repository.toLowerCase() !== task.repository.toLowerCase() ||
      pr.number !== task.prNumber ||
      pr.baseBranch !== task.baseBranch
    )
      return this.block(projectPath, task, 'MERGE_IDENTITY_MISMATCH');
    if (pr.headSha !== task.prHeadSha) return this.stale(projectPath, task, pr.headSha);
    if (task.mergeCommitSha && task.mergeCommitSha !== pr.mergeCommitSha)
      return this.block(projectPath, task, 'MERGE_IDENTITY_MISMATCH');
    if (!task.mergeCommitSha || !task.externalMerge) {
      const policy = await fs.readFile(path.join(projectPath, '.automaker', 'argus.yaml'), 'utf8');
      try {
        this.git.assertMergeGate(
          { ...task, phase: 'merge-ready' },
          pr,
          /deployment:\s*disabled/.test(policy)
        );
      } catch (error) {
        return this.block(projectPath, task, (error as Error).message);
      }
      await this.confirmMerge(projectPath, task, pr.mergeCommitSha);
      if (task.phase === 'blocked') return;
    }
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
    if (task.phase !== 'done') {
      task.phase = 'done';
      task.nextAction = 'objective-evaluation';
      this.event(task, 'TASK_DONE');
      state.consecutiveSpecRenewalsWithoutCompletedTask = 0;
      await this.persist(projectPath, task, 'verified');
    }
    await this.evaluateObjective(projectPath, task);
  }

  private async confirmMerge(projectPath: string, task: ArgusTaskState, sha: string | null) {
    if (!sha) return this.block(projectPath, task, 'REMOTE_MERGE_NOT_FOUND');
    task.mergeCommitSha = sha;
    task.mergedSha = sha;
    task.mergedAt = new Date().toISOString();
    if (task.mergeIntent) task.mergeIntent.mergeOutcome = 'merged';
    task.externalMerge = {
      repository: task.repository!,
      prNumber: task.prNumber!,
      headSha: task.prHeadSha!,
      baseBranch: task.baseBranch!,
      mergeCommitSha: sha,
      observedAt: new Date().toISOString(),
    };
    if (!['local-sync', 'local-synced', 'done'].includes(task.phase)) task.phase = 'merged';
    this.event(task, 'MERGE_CONFIRMED');
    await this.persist(projectPath, task);
  }
  private async stale(projectPath: string, task: ArgusTaskState, head: string) {
    task.lokiEvidence = null;
    task.integrationEvidence = null;
    task.prHeadSha = head;
    task.ciHeadSha = null;
    task.ciState = 'pending';
    task.reviewedHeadSha = null;
    task.reviewVerdict = null;
    task.reviewFindings = [];
    if (task.mergeIntent) task.mergeIntent.mergeOutcome = 'failed';
    task.humanMergeGate = null;
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
        await new TaskHistoryStore().archive(projectPath, task, 'completed');
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
      await new TaskHistoryStore().archive(projectPath, task, 'completed');
      await this.specs.renew(projectPath, state, nextSpec, evaluation);
      this.event(task, 'SPEC_RENEWED');
      this.event(task, 'NEXT_CAMPAIGN_STARTED');
      await new ArgusBoardProjector(this.features).project(projectPath, task);
      // The authoritative runner admits the next task after checking campaign budgets.
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
    await new ArgusBoardProjector(this.features).project(projectPath, task);
  }
}

import type { FeatureLoader } from '../feature-loader.js';
import { saveArgusState } from './project-lifecycle.js';
import type { ArgusService, ArgusTaskState, SeniorReview } from './types.js';
import type { GitHubCiObserver } from './github-ci-observer.js';
import type { JulesClient } from './jules-client.js';
import type { OpenCodeRoleRunner } from './opencode-role-runner.js';
import fs from 'fs/promises';
import path from 'path';

const ACTIVE_JULES = new Set([
  'QUEUED',
  'PLANNING',
  'AWAITING_PLAN_APPROVAL',
  'AWAITING_USER_FEEDBACK',
  'IN_PROGRESS',
  'PAUSED',
]);
const locks = new Map<string, Promise<void>>();

export interface SeniorWorktreeAdapter {
  prepare(projectPath: string, branch: string, baseSha: string): Promise<string>;
  commit(worktree: string, message: string): Promise<string>;
}

export class MilestoneDOrchestrator {
  constructor(
    private argus: ArgusService,
    private features: FeatureLoader,
    private github: GitHubCiObserver,
    private jules: JulesClient,
    private senior: OpenCodeRoleRunner,
    private worktrees?: SeniorWorktreeAdapter
  ) {}

  async reconcile(projectPath: string): Promise<void> {
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
    const state = await this.argus.getStatus(projectPath);
    const task = state?.activeTask;
    if (!state || !task || !task.repository || !task.prNumber) return;
    const pr = await this.github.getPullRequest(task.repository, task.prNumber);
    if (
      pr.repository !== task.repository.toLowerCase() ||
      pr.baseBranch !== task.baseBranch ||
      pr.state !== 'OPEN'
    ) {
      return this.block(projectPath, task, 'GITHUB_PR_IDENTITY_MISMATCH');
    }
    if (task.prHeadSha !== pr.headSha) {
      task.prHeadSha = pr.headSha;
      this.invalidateEvidence(task);
      this.event(task, 'PR_HEAD_CHANGED', { headSha: pr.headSha });
      task.phase = 'ci-check';
      await this.persist(projectPath, task);
    }
    if (task.phase === 'jules-repair' || task.phase === 'senior-guided-repair') return;
    if (task.phase === 'senior-takeover') return this.takeOver(projectPath, task);
    if (task.phase === 'senior-patch-ready' || task.phase === 'merge-ready') return;
    task.phase = 'ci-check';
    this.event(task, 'CI_OBSERVATION_STARTED');
    const ci = await this.github.observe(task.repository, task.prHeadSha!);
    if (ci.headSha !== task.prHeadSha) return;
    task.ciHeadSha = ci.headSha;
    task.ciState = ci.state;
    task.ciObservedAt = ci.observedAt;
    task.ciRunIds = ci.runIds;
    task.failingChecks = ci.failures;
    if (ci.state === 'not-configured')
      return this.block(projectPath, task, 'CI_REQUIRED_BUT_NOT_CONFIGURED');
    if (ci.state === 'pending' || ci.state === 'unknown' || ci.state === 'cancelled') {
      this.event(task, ci.state === 'pending' ? 'CI_PENDING' : 'CI_INCOMPLETE');
      task.nextAction = 'observe-ci';
      return this.persist(projectPath, task);
    }
    if (ci.state === 'failure') return this.repairOrDiagnose(projectPath, task, 'ci');
    this.event(task, 'CI_SUCCESS');
    await this.review(projectPath, task);
  }

  private async repairOrDiagnose(projectPath: string, task: ArgusTaskState, kind: 'ci' | 'review') {
    task.phase = 'ci-failed';
    this.event(task, 'CI_FAILED');
    const active = Boolean(
      task.julesSessionId && task.julesState && ACTIVE_JULES.has(task.julesState)
    );
    if (!active) {
      this.event(task, 'JULES_TERMINAL_REPAIR_UNSAFE');
      return this.diagnose(projectPath, task);
    }
    if (task.julesRepairAttempt >= 2) {
      this.event(task, 'JULES_REPAIR_EXHAUSTED');
      return this.diagnose(projectPath, task);
    }
    task.repairKind = kind;
    task.julesRepairAttempt += 1;
    task.repairAgainstHeadSha = task.prHeadSha;
    task.phase = 'jules-repair';
    this.event(task, 'JULES_REPAIR_REQUESTED', { attempt: task.julesRepairAttempt });
    await this.persist(projectPath, task); // durable counter before remote side effect
    await this.jules.sendMessage(task.julesSessionId!, this.repairPrompt(task));
    this.event(task, 'JULES_REPAIR_SENT', { attempt: task.julesRepairAttempt });
    await this.persist(projectPath, task);
  }

  private async diagnose(projectPath: string, task: ArgusTaskState) {
    task.phase = 'senior-diagnosis';
    this.event(task, 'SENIOR_DIAGNOSIS_STARTED');
    await this.persist(projectPath, task);
    const diagnosis = await this.senior.diagnose(await this.reviewPayload(projectPath, task));
    task.seniorDiagnosis = diagnosis.result;
    this.event(task, 'SENIOR_DIAGNOSIS_COMPLETED');
    if (
      diagnosis.result.juniorCanRepair &&
      task.julesSessionId &&
      task.julesState &&
      ACTIVE_JULES.has(task.julesState) &&
      task.seniorGuidedRepairAttempt < 1
    ) {
      task.seniorGuidedRepairAttempt += 1;
      task.phase = 'senior-guided-repair';
      task.repairAgainstHeadSha = task.prHeadSha;
      await this.persist(projectPath, task);
      await this.jules.sendMessage(
        task.julesSessionId,
        `Senior diagnosis for ${task.prHeadSha}: ${diagnosis.result.recommendedFix}\nDo not deploy or modify ARGUS.md.`
      );
      return;
    }
    await this.takeOver(projectPath, task);
  }

  private async review(projectPath: string, task: ArgusTaskState) {
    task.phase = 'senior-review';
    this.event(task, 'SENIOR_REVIEW_STARTED');
    await this.persist(projectPath, task);
    const review = await this.senior.review(await this.reviewPayload(projectPath, task));
    await this.acceptReview(projectPath, task, review.result);
  }

  private async acceptReview(projectPath: string, task: ArgusTaskState, review: SeniorReview) {
    const current = await this.github.getPullRequest(task.repository!, task.prNumber!);
    if (review.reviewedHeadSha !== task.prHeadSha || current.headSha !== task.prHeadSha) {
      this.invalidateEvidence(task);
      task.prHeadSha = current.headSha;
      task.phase = 'ci-check';
      this.event(task, 'REVIEW_STALE');
      return this.persist(projectPath, task);
    }
    task.reviewedHeadSha = review.reviewedHeadSha;
    task.reviewVerdict = review.verdict;
    task.reviewFindings = review.findings;
    if (review.verdict === 'approve') {
      task.phase = 'merge-ready';
      task.nextAction = 'await-merge-milestone';
      this.event(task, 'SENIOR_REVIEW_APPROVED');
      this.event(task, 'MERGE_READY');
      return this.persist(projectPath, task);
    }
    if (review.verdict === 'request_changes') {
      task.phase = 'review-changes';
      this.event(task, 'SENIOR_REVIEW_CHANGES');
      await this.persist(projectPath, task);
      return this.repairOrDiagnose(projectPath, task, 'review');
    }
    return this.block(projectPath, task, 'SENIOR_REVIEW_BLOCKED');
  }

  private async takeOver(projectPath: string, task: ArgusTaskState) {
    task.lease = null;
    const now = new Date().toISOString();
    task.lease = { taskId: task.taskId, executor: 'senior', acquiredAt: now, heartbeatAt: now };
    task.executor = 'senior';
    task.phase = 'senior-takeover';
    this.event(task, 'SENIOR_TAKEOVER');
    await this.persist(projectPath, task);
    if (!this.worktrees) return;
    const branch = `automaker/senior/${task.taskId.replace(/[^a-z0-9._-]+/gi, '-').toLowerCase()}`;
    task.seniorBranch = branch;
    task.seniorBaseHeadSha = task.prHeadSha;
    task.seniorWorktreePath ||= await this.worktrees.prepare(projectPath, branch, task.prHeadSha!);
    await this.persist(projectPath, task);
    const execution = await this.senior.execute(
      `Implement the bounded fix. Never modify ARGUS.md, deploy, release, publish, merge, or force-push.\n${JSON.stringify(task.seniorDiagnosis)}`,
      task.seniorWorktreePath
    );
    task.seniorExecutionContextId = execution.contextId;
    await this.worktrees.commit(task.seniorWorktreePath, `fix: senior repair for ${task.taskId}`);
    task.phase = 'senior-patch-ready';
    task.lease = null;
    this.event(task, 'SENIOR_PATCH_READY');
    await this.persist(projectPath, task);
  }

  private invalidateEvidence(task: ArgusTaskState) {
    task.ciHeadSha = null;
    task.ciState = 'pending';
    task.ciObservedAt = null;
    task.ciRunIds = [];
    task.failingChecks = [];
    task.reviewedHeadSha = null;
    task.reviewVerdict = null;
    task.reviewFindings = [];
  }
  private event(task: ArgusTaskState, type: string, details?: Record<string, unknown>) {
    task.lastArgusEvent = type;
    task.events.push({ type, at: new Date().toISOString(), details });
    task.events = task.events.slice(-100);
  }
  private async reviewPayload(projectPath: string, task: ArgusTaskState) {
    const [charter, spec, diff] = await Promise.all([
      fs.readFile(path.join(projectPath, 'ARGUS.md'), 'utf8'),
      fs.readFile(path.join(projectPath, 'spec.md'), 'utf8'),
      this.github.getPullRequestDiff(task.repository!, task.prNumber!),
    ]);
    return {
      charter: charter.slice(0, 30_000),
      spec: spec.slice(0, 30_000),
      diff,
      taskId: task.taskId,
      objective: task.objective,
      acceptanceCriteria: task.acceptanceCriteria,
      evidenceRequired: task.evidenceRequired,
      sourceSpecRevision: task.sourceSpecRevision,
      prNumber: task.prNumber,
      prHeadSha: task.prHeadSha,
      ciHeadSha: task.ciHeadSha,
      ciState: task.ciState,
      failures: task.failingChecks,
    };
  }
  private repairPrompt(task: ArgusTaskState) {
    return `Exact failures for PR head ${task.prHeadSha}:\n${JSON.stringify(task.failingChecks)}\nFix only these causes, commit changes, do not deploy, and do not modify ARGUS.md.`;
  }
  private async block(projectPath: string, task: ArgusTaskState, reason: string) {
    task.phase = 'blocked';
    task.blockedReason = reason;
    task.nextAction = 'operator-attention';
    this.event(task, reason);
    await this.persist(projectPath, task);
  }
  private async persist(projectPath: string, task: ArgusTaskState) {
    const state = await this.argus.getStatus(projectPath);
    if (!state) throw new Error('Argus project missing');
    state.activeTask = task;
    state.phase = task.phase;
    state.latestStatus = task.lastArgusEvent;
    await saveArgusState(projectPath, state);
    await this.features.update(projectPath, task.featureId, {
      status: task.phase === 'blocked' ? 'failed' : 'review',
      argus: { ...task },
    });
  }
}

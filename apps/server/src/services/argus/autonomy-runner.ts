import { ArgusCampaignManager } from './campaigns.js';
import { sanitizeOpenCodeOutput } from '../../lib/opencode-errors.js';
import fs from 'fs';
import path from 'path';
import { updateDurableJson, readDurableJson } from './durable-store.js';
import { saveArgusState } from './project-lifecycle.js';
import type {
  ArgusProjectState,
  ArgusService,
  ArgusTaskState,
  DeveloperExecutor,
} from './types.js';

const QUIET_PHASES = new Set(['blocked', 'error', 'objective-satisfied', 'senior-patch-ready']);
const EXECUTOR_PHASES = new Set([
  'awaiting-executor',
  'jules-running',
  'jules-repair',
  'senior-guided-repair',
]);
const MILESTONE_D_PHASES = new Set([
  'loki-gate',
  'pr-open',
  'ci-check',
  'ci-failed',
  'senior-diagnosis',
  'senior-review',
  'review-changes',
  'senior-takeover',
  'approved',
]);
const MILESTONE_E_PHASES = new Set([
  'merge-ready',
  'merge-intent',
  'merging',
  'merged',
  'git-recovery',
  'local-sync',
  'local-synced',
  'done',
  'objective-evaluation',
  'spec-renewal',
]);
const PERMANENT =
  /AUTH|SOURCE_NOT_FOUND|SOURCE_UNAVAILABLE|NOT_PERMITTED|CONFLICT|REJECTED|UPSTREAM_CONTRACT_MISMATCH|DEPLOY|MALFORMED/;

export interface ReconcileDecision {
  needsReconcile: boolean;
  nextReconcileAt: string | null;
  reason: string;
}

export interface AutonomyRunnerHealth {
  runtime: 'running' | 'degraded' | 'stopped';
  pendingProjects: number;
  blockedProjects: number;
  nextWakeAt: string | null;
}

export interface ArgusControlRequest {
  revision: number;
  handledRevision: number;
  desiredAutonomy?: 'enabled' | 'paused';
  reason: string;
  requestedAt: string;
}

export class ArgusAutonomyRunner {
  private projects = new Set<string>();
  private locks = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly argus: ArgusService,
    private readonly planner: { reconcileProject(path: string): Promise<ArgusTaskState | null> },
    private readonly executor: DeveloperExecutor | undefined,
    private readonly milestoneD: { reconcile(path: string): Promise<void> } | undefined,
    private readonly milestoneE: { reconcile(path: string): Promise<void> },
    private readonly options: {
      campaigns?: ArgusCampaignManager;
      now?: () => number;
      jitter?: () => number;
      setTimer?: typeof setTimeout;
      clearTimer?: typeof clearTimeout;
    } = {}
  ) {}

  register(projectPath: string) {
    this.projects.add(fs.realpathSync(projectPath));
  }

  async start() {
    this.running = true;
    await this.tick();
  }

  stop() {
    this.running = false;
    if (this.timer) (this.options.clearTimer || clearTimeout)(this.timer);
    this.timer = null;
  }

  /** Durable, bounded API acknowledgement; remote work only happens in tick/reconcile. */
  async requestReconcile(
    projectPath: string,
    reason = 'explicit-wake',
    action?: 'pause' | 'resume'
  ) {
    projectPath = fs.realpathSync(projectPath);
    this.register(projectPath);
    const request = await updateDurableJson<ArgusControlRequest>(
      this.controlPath(projectPath),
      (current) => ({
        ...current,
        revision: (current?.revision || 0) + 1,
        handledRevision: current?.handledRevision || 0,
        desiredAutonomy:
          action === 'pause'
            ? 'paused'
            : action === 'resume'
              ? 'enabled'
              : current && current.revision > current.handledRevision
                ? current.desiredAutonomy
                : undefined,
        reason: reason.slice(0, 100),
        requestedAt: new Date(this.now()).toISOString(),
      })
    );
    this.arm();
    return request;
  }

  async control(projectPath: string) {
    return readDurableJson<ArgusControlRequest>(this.controlPath(projectPath));
  }

  private controlPath(projectPath: string) {
    return path.join(projectPath, '.automaker', 'argus-control.json');
  }

  private async applyControl(projectPath: string, state: ArgusProjectState) {
    const control = await this.control(projectPath);
    if (!control) return;
    if (control.revision > control.handledRevision) {
      if (control.desiredAutonomy) state.autonomy = control.desiredAutonomy;
      state.reconciliation.reason = control.reason;
      await saveArgusState(projectPath, state);
      await updateDurableJson<ArgusControlRequest>(this.controlPath(projectPath), (latest) => ({
        ...latest!,
        handledRevision: Math.max(latest?.handledRevision || 0, control.revision),
      }));
    }
  }

  async wake(projectPath: string, reason = 'explicit-wake') {
    this.register(projectPath);
    await this.requestReconcile(projectPath, reason);
    await this.reconcile(projectPath);
    this.arm();
  }

  async tick() {
    if (!this.running) return;
    const now = this.now();
    await Promise.all(
      [...this.projects].map(async (projectPath) => {
        const state = await this.argus.getStatus(projectPath);
        const control = await this.control(projectPath);
        if (control && control.revision > control.handledRevision)
          await this.reconcile(projectPath);
        else if (state?.reconciliation.nextAt && Date.parse(state.reconciliation.nextAt) <= now)
          await this.reconcile(projectPath);
      })
    );
    this.arm();
  }

  async reconcile(projectPath: string) {
    projectPath = fs.realpathSync(projectPath);
    const previous = this.locks.get(projectPath) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    const queued = previous.then(() => current);
    this.locks.set(projectPath, queued);
    await previous;
    try {
      await this.reconcileLocked(projectPath);
    } finally {
      release();
      if (this.locks.get(projectPath) === queued) this.locks.delete(projectPath);
    }
  }

  decision(state: ArgusProjectState): ReconcileDecision {
    if (state.autonomy !== 'enabled' || QUIET_PHASES.has(state.phase))
      return { needsReconcile: false, nextReconcileAt: null, reason: state.phase };
    const delay = this.delayFor(state);
    return {
      needsReconcile: true,
      nextReconcileAt: new Date(this.now() + delay).toISOString(),
      reason: state.activeTask?.nextAction || state.phase,
    };
  }

  async health(): Promise<AutonomyRunnerHealth> {
    const states = await Promise.all([...this.projects].map((path) => this.argus.getStatus(path)));
    const active = states.filter((state): state is ArgusProjectState => Boolean(state));
    const pending = active.filter((state) => Boolean(state.reconciliation.nextAt));
    return {
      runtime: !this.running
        ? 'stopped'
        : active.some((state) => Boolean(state.reconciliation.lastError))
          ? 'degraded'
          : 'running',
      pendingProjects: pending.length,
      blockedProjects: active.filter(
        (state) => state.phase === 'blocked' || state.phase === 'error'
      ).length,
      nextWakeAt: pending.map((state) => state.reconciliation.nextAt!).sort()[0] || null,
    };
  }

  private async reconcileLocked(projectPath: string) {
    let before = await this.argus.getStatus(projectPath);
    if (!before) return;
    await this.applyControl(projectPath, before);
    const campaign = await this.options.campaigns?.beforeCycle(projectPath, before);
    if (
      campaign?.allowReconcile === false ||
      before.autonomy !== 'enabled' ||
      QUIET_PHASES.has(before.phase)
    ) {
      before.reconciliation.nextAt = campaign?.nextCheckAt || null;
      before.reconciliation.reason = before.phase;
      before.reconciliation.lastFinishedAt = new Date(this.now()).toISOString();
      await saveArgusState(projectPath, before);
      return;
    }
    before.reconciliation.lastStartedAt = new Date(this.now()).toISOString();
    before.reconciliation.nextAt = null;
    await saveArgusState(projectPath, before);
    const marker = this.marker(before);
    try {
      // A bounded loop closes synchronous transitions, including renewed campaigns,
      // without busy-polling remote systems.
      for (let transition = 0; transition < 8; transition++) {
        const state = await this.argus.getStatus(projectPath);
        if (state) await this.applyControl(projectPath, state);
        if (!state || state.autonomy !== 'enabled' || QUIET_PHASES.has(state.phase)) break;
        const budget = await this.options.campaigns?.beforeCycle(projectPath, state);
        if (budget?.allowReconcile === false) break;
        const task = state.activeTask;
        if (!task || state.phase === 'planning' || state.phase === 'idle') {
          if (budget?.allowNewTasks === false) break;
          await this.planner.reconcileProject(projectPath);
          continue;
        }
        if (task.phase === 'awaiting-executor') {
          if (
            budget?.allowNewTasks === false ||
            (this.options.campaigns &&
              !(await this.options.campaigns.reserveTask(projectPath, task)))
          )
            break;
          if (task.executor === 'jules' && this.executor)
            await this.executor.dispatch(task, projectPath);
          else {
            task.phase = 'blocked';
            task.blockedReason =
              task.executor === 'senior'
                ? 'SENIOR_INITIAL_EXECUTION_UNAVAILABLE'
                : 'EXECUTOR_UNAVAILABLE';
            task.nextAction = 'operator-attention';
            state.phase = task.phase;
            await saveArgusState(projectPath, state);
          }
          continue;
        }
        if (EXECUTOR_PHASES.has(task.phase)) {
          if (task.executor === 'jules' && this.executor)
            await this.executor.reconcile(task, projectPath);
          else break;
          const refreshed = await this.argus.getStatus(projectPath);
          if (
            refreshed?.activeTask &&
            (refreshed.activeTask.phase === 'jules-repair' ||
              refreshed.activeTask.phase === 'senior-guided-repair') &&
            (refreshed.activeTask.julesState === 'COMPLETED' ||
              refreshed.activeTask.julesState === 'FAILED') &&
            this.milestoneD
          ) {
            await this.milestoneD.reconcile(projectPath);
            continue;
          }
          if (
            !refreshed?.activeTask?.prNumber ||
            refreshed.activeTask.phase === 'jules-running' ||
            refreshed.activeTask.phase === 'jules-repair' ||
            refreshed.activeTask.phase === 'senior-guided-repair'
          )
            break;
          continue;
        }
        if (MILESTONE_D_PHASES.has(task.phase)) {
          if (!this.milestoneD) break;
          await this.milestoneD.reconcile(projectPath);
          const refreshed = await this.argus.getStatus(projectPath);
          if (
            refreshed?.activeTask &&
            (refreshed.activeTask.phase === 'ci-check' ||
              refreshed.activeTask.phase === 'jules-repair' ||
              refreshed.activeTask.phase === 'senior-guided-repair' ||
              refreshed.activeTask.phase === 'senior-patch-ready')
          )
            break;
          continue;
        }
        if (MILESTONE_E_PHASES.has(task.phase)) {
          await this.milestoneE.reconcile(projectPath);
          continue;
        }
        break;
      }
      const state = await this.argus.getStatus(projectPath);
      if (!state) return;
      const progressed = marker !== this.marker(state);
      state.reconciliation.attempt = progressed ? 0 : state.reconciliation.attempt;
      state.reconciliation.lastFinishedAt = new Date(this.now()).toISOString();
      state.reconciliation.lastError = null;
      await this.options.campaigns?.observe(projectPath, state);
      const campaign = await this.options.campaigns?.beforeCycle(projectPath, state);
      const decision = this.decision(state);
      state.reconciliation.nextAt = campaign?.exists
        ? campaign.nextCheckAt
        : decision.nextReconcileAt;
      state.reconciliation.reason = decision.reason;
      await saveArgusState(projectPath, state);
    } catch (error) {
      const state = await this.argus.getStatus(projectPath);
      if (!state) return;
      const message = sanitizeOpenCodeOutput(
        error instanceof Error ? error.message : String(error)
      );
      state.reconciliation.lastFinishedAt = new Date(this.now()).toISOString();
      state.reconciliation.lastError = message.slice(0, 300);
      state.reconciliation.attempt += 1;
      if (PERMANENT.test(message) || state.reconciliation.attempt >= 6) {
        state.phase = 'blocked';
        if (state.activeTask) {
          state.activeTask.phase = 'blocked';
          state.activeTask.blockedReason = message.split(':')[0];
          state.activeTask.nextAction = 'operator-attention';
        }
        state.reconciliation.nextAt = null;
        state.reconciliation.reason = 'permanent-error';
      } else {
        state.reconciliation.nextAt = new Date(
          this.now() + this.backoff(state.reconciliation.attempt)
        ).toISOString();
        state.reconciliation.reason = 'transient-retry';
      }
      await saveArgusState(projectPath, state);
      await this.options.campaigns?.observe(projectPath, state);
    }
  }

  private delayFor(state: ArgusProjectState) {
    const phase = state.activeTask?.phase || state.phase;
    const base =
      phase === 'jules-running' || phase.includes('repair')
        ? 15_000
        : phase === 'ci-check'
          ? 30_000
          : phase === 'merge-intent' || phase === 'merging'
            ? 60_000
            : 10_000;
    return (
      base + Math.floor((this.options.jitter?.() ?? Math.random()) * Math.min(5_000, base / 4))
    );
  }

  private backoff(attempt: number) {
    return Math.min(
      300_000,
      [10_000, 20_000, 30_000, 60_000, 120_000, 300_000][attempt - 1] || 300_000
    );
  }

  private marker(state: ArgusProjectState) {
    return `${state.specRevision}:${state.phase}:${state.activeTask?.taskId || ''}:${state.activeTask?.phase || ''}:${state.activeTask?.lastArgusEvent || ''}`;
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  private arm() {
    if (!this.running) return;
    if (this.timer) (this.options.clearTimer || clearTimeout)(this.timer);
    const setTimer = this.options.setTimer || setTimeout;
    this.timer = setTimer(() => void this.tick(), 10_000);
    this.timer.unref?.();
  }
}

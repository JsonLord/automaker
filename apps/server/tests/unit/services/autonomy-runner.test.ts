import { FeatureLoader } from '../../../src/services/feature-loader.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  ArgusAutonomyRunner,
  MilestoneEOrchestrator,
  GitIntegrationService,
  ensureArgusControlFiles,
  resolveState,
  type ArgusProjectState,
  type ArgusTaskState,
} from '../../../src/services/argus/index.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-runner-'));
  dirs.push(dir);
  await ensureArgusControlFiles(dir, '# Campaign 1', '# Immutable objective');
  const state = await resolveState('project', dir, 'model');
  state.autonomy = 'enabled';
  const service = {
    getStatus: vi.fn(async () => state),
  } as any;
  return { dir, state, service };
}

function task(revision: number): ArgusTaskState {
  return {
    taskId: `task-${revision}`,
    title: `Campaign ${revision}`,
    objective: 'Advance objective',
    description: 'Bounded implementation',
    acceptanceCriteria: ['tests pass'],
    evidenceRequired: ['test output'],
    recommendedExecutor: 'junior',
    dependencies: [],
    risk: 'normal',
    sourceSpecRevision: revision,
    featureId: `argus-task-${revision}`,
    phase: 'awaiting-executor',
    executor: 'jules',
    julesSessionId: null,
    julesSourceId: null,
    julesState: null,
    julesBranch: null,
    prNumber: null,
    prUrl: null,
    baseBranch: null,
    baseRemoteSha: null,
    repository: null,
    prHeadSha: null,
    reviewedHeadSha: null,
    mergedSha: null,
    localSyncedSha: null,
    retryCount: 0,
    lastArgusEvent: 'ARGUS_TASK_PLANNED',
    blockedReason: null,
    lease: null,
    dispatchIntent: null,
    ciHeadSha: null,
    ciState: 'unknown',
    ciObservedAt: null,
    ciRunIds: [],
    failingChecks: [],
    repairKind: null,
    julesRepairAttempt: 0,
    seniorGuidedRepairAttempt: 0,
    repairSessionId: null,
    repairAgainstHeadSha: null,
    seniorDiagnosis: null,
    reviewVerdict: null,
    reviewFindings: [],
    seniorWorktreePath: null,
    seniorBranch: null,
    seniorBaseHeadSha: null,
    seniorExecutionContextId: null,
    nextAction: 'dispatch-jules',
    events: [],
    mergeIntent: null,
    mergeExpectedHeadSha: null,
    mergeAttemptedAt: null,
    mergeCommitSha: null,
    baseHeadAfterMergeSha: null,
    mergedAt: null,
    remoteBaseSha: null,
    localBaseSha: null,
    recoveryRef: null,
    recoveryReason: null,
    recoveryOriginalHead: null,
    recoveryCreatedAt: null,
    recoverySnapshots: [],
    objectiveEvaluation: null,
  };
}

describe('ArgusAutonomyRunner', () => {
  it('persists adaptive wake-up state and stays quiet when the objective is satisfied', async () => {
    const { dir, state, service } = await fixture();
    let now = Date.parse('2026-10-06T00:00:00Z');
    state.phase = 'ci-check';
    state.activeTask = task(1);
    state.activeTask.phase = 'ci-check';
    state.activeTask.nextAction = 'observe-ci';
    state.reconciliation.nextAt = new Date(0).toISOString();
    const runner = new ArgusAutonomyRunner(
      service,
      { reconcileProject: vi.fn() },
      undefined,
      { reconcile: vi.fn() },
      { reconcile: vi.fn() },
      { now: () => now, jitter: () => 0, setTimer: (() => ({ unref() {} })) as any }
    );
    runner.register(dir);
    await runner.start();
    expect(state.reconciliation).toMatchObject({
      nextAt: '2026-10-06T00:00:30.000Z',
      reason: 'observe-ci',
      lastStartedAt: '2026-10-06T00:00:00.000Z',
    });
    state.autonomy = 'satisfied';
    state.phase = 'objective-satisfied';
    state.activeTask = null;
    now += 30_000;
    await runner.wake(dir, 'restart');
    expect(state.reconciliation.nextAt).toBeNull();
    expect((await runner.health()).pendingProjects).toBe(0);
    runner.stop();
  });

  it.each(['enabled', 'paused'] as const)(
    'startup and scheduler preserve the human gate for %s projects',
    async (autonomy) => {
      const { dir, state, service } = await fixture();
      state.autonomy = autonomy;
      state.activeTask = task(1);
      Object.assign(state.activeTask, {
        repository: 'o/r',
        prNumber: 7,
        baseBranch: 'main',
        phase: 'merge-ready',
        prHeadSha: 'a'.repeat(40),
        ciHeadSha: 'a'.repeat(40),
        reviewedHeadSha: 'a'.repeat(40),
        reviewVerdict: 'approve',
        ciState: 'success',
      });
      state.phase = 'merge-ready';
      state.reconciliation.nextAt = new Date(0).toISOString();
      let now = Date.parse('2026-10-23T00:00:00Z');
      const github = {
        mergePullRequest: vi.fn(),
        getPullRequest: vi.fn(async () => ({
          repository: 'o/r',
          number: 7,
          baseBranch: 'main',
          baseSha: 'b'.repeat(40),
          headSha: 'a'.repeat(40),
          headBranch: 'work',
          state: 'OPEN',
          merged: false,
          mergeCommitSha: null,
          url: 'https://github.com/o/r/pull/7',
        })),
      };
      const planner = { reconcileProject: vi.fn() };
      const dispatch = vi.fn();
      const observer = new MilestoneEOrchestrator(
        service,
        new FeatureLoader(),
        new GitIntegrationService(github as never)
      );
      const createRunner = () =>
        new ArgusAutonomyRunner(
          service,
          planner,
          { id: 'jules', dispatch, reconcile: vi.fn() },
          undefined,
          observer,
          { now: () => now, jitter: () => 0, setTimer: (() => ({ unref() {} })) as any }
        );
      const first = createRunner();
      first.register(dir);
      await first.start();
      first.stop();
      expect(github.getPullRequest).toHaveBeenCalledTimes(autonomy === 'enabled' ? 1 : 0);
      if (autonomy === 'enabled') {
        expect(state.activeTask!.nextAction).toBe('human-merge-required');
        expect(state.reconciliation.nextAt).toBe('2026-10-23T00:01:00.000Z');
      }
      const recovered = await resolveState('project', dir, 'model');
      service.getStatus.mockImplementation(async () => recovered);
      now += 65_000;
      const restarted = createRunner();
      restarted.register(dir);
      await restarted.start();
      restarted.stop();
      expect(github.getPullRequest).toHaveBeenCalledTimes(autonomy === 'enabled' ? 2 : 0);
      expect(recovered.autonomy).toBe(autonomy);
      expect(github.mergePullRequest).not.toHaveBeenCalled();
      expect(planner.reconcileProject).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
    }
  );

  it('automatically dispatches the first and renewed campaign and stops after satisfaction', async () => {
    const { dir, state, service } = await fixture();
    const dispatches: string[] = [];
    const merges: string[] = [];
    const externallyMerged = new Set<string>();
    let campaign = 1;
    let ciAttempt = 0;
    const planner = {
      reconcileProject: vi.fn(async () => {
        state.activeTask ||= task(state.specRevision);
        state.phase = state.activeTask.phase;
        return state.activeTask;
      }),
    };
    const executor = {
      id: 'jules' as const,
      dispatch: vi.fn(async (value: ArgusTaskState) => {
        dispatches.push(value.taskId);
        value.julesSessionId = `session-${value.sourceSpecRevision}`;
        value.julesState = 'IN_PROGRESS';
        value.phase = 'jules-running';
        state.phase = value.phase;
      }),
      reconcile: vi.fn(async (value: ArgusTaskState) => {
        value.repository = 'o/r';
        value.baseBranch = 'main';
        value.prNumber = value.sourceSpecRevision;
        value.prHeadSha = `head-${value.sourceSpecRevision}-${ciAttempt}`;
        value.phase = 'pr-open';
        state.phase = value.phase;
      }),
    };
    const milestoneD = {
      reconcile: vi.fn(async () => {
        const value = state.activeTask!;
        if (value.phase === 'pr-open') {
          value.phase = 'ci-check';
          value.nextAction = 'observe-ci';
        } else if (value.phase === 'ci-check' && campaign === 1 && ciAttempt++ === 0) {
          value.phase = 'jules-repair';
          value.nextAction = 'reconcile-jules-repair';
          value.julesRepairAttempt = 1;
        } else {
          value.ciState = 'success';
          value.ciHeadSha = value.prHeadSha;
          value.reviewedHeadSha = value.prHeadSha;
          value.reviewVerdict = 'approve';
          value.phase = 'merge-ready';
        }
        state.phase = value.phase;
      }),
    };
    const milestoneE = {
      reconcile: vi.fn(async () => {
        const value = state.activeTask!;
        if (!externallyMerged.has(value.taskId)) {
          value.nextAction = 'human-merge-required';
          return;
        }
        merges.push(value.taskId);
        if (campaign++ === 1) {
          state.specRevision = 2;
          state.activeTask = null;
          state.phase = 'planning';
        } else {
          state.activeTask = null;
          state.phase = 'objective-satisfied';
          state.autonomy = 'satisfied';
        }
      }),
    };
    const runner = new ArgusAutonomyRunner(service, planner, executor, milestoneD, milestoneE, {
      jitter: () => 0,
    });

    // Remote waits are represented by separate durable wake-ups; no UI action or restart is used.
    for (let wake = 0; wake < 16 && state.autonomy === 'enabled'; wake++) {
      if (state.activeTask?.nextAction === 'human-merge-required')
        externallyMerged.add(state.activeTask.taskId);
      await runner.wake(dir, `fake-remote-event-${wake}`);
    }

    expect(dispatches).toEqual(['task-1', 'task-2']);
    expect(merges).toEqual(['task-1', 'task-2']);
    expect(state.specRevision).toBe(2);
    expect(state.autonomy).toBe('satisfied');
    expect(state.phase).toBe('objective-satisfied');
    expect(state.activeTask).toBeNull();
    expect(state.reconciliation.nextAt).toBeNull();
    expect(planner.reconcileProject).toHaveBeenCalledTimes(2);
  });

  it('serializes concurrent ticks so one awaiting task is dispatched exactly once', async () => {
    const { dir, state, service } = await fixture();
    state.activeTask = task(1);
    state.phase = 'awaiting-executor';
    let dispatches = 0;
    const executor = {
      id: 'jules' as const,
      dispatch: vi.fn(async (value: ArgusTaskState) => {
        dispatches += 1;
        await Promise.resolve();
        value.julesSessionId = 'only-session';
        value.phase = 'jules-running';
        state.phase = value.phase;
      }),
      reconcile: vi.fn(),
    };
    const runner = new ArgusAutonomyRunner(
      service,
      { reconcileProject: vi.fn() },
      executor,
      { reconcile: vi.fn() },
      { reconcile: vi.fn() },
      { jitter: () => 0 }
    );
    await Promise.all([1, 2, 3, 4].map(() => runner.reconcile(dir)));
    expect(dispatches).toBe(1);
    expect(state.activeTask.julesSessionId).toBe('only-session');
  });

  it('schedules bounded transient backoff and blocks permanent contract failures', async () => {
    const transient = await fixture();
    let now = Date.parse('2026-10-06T00:00:00Z');
    const transientRunner = new ArgusAutonomyRunner(
      transient.service,
      { reconcileProject: vi.fn().mockRejectedValue(new Error('network timeout')) },
      undefined,
      undefined,
      { reconcile: vi.fn() },
      { now: () => now, jitter: () => 0 }
    );
    await transientRunner.reconcile(transient.dir);
    expect(transient.state.reconciliation).toMatchObject({
      attempt: 1,
      nextAt: '2026-10-06T00:00:10.000Z',
      reason: 'transient-retry',
      lastError: 'network timeout',
    });

    const permanent = await fixture();
    const permanentRunner = new ArgusAutonomyRunner(
      permanent.service,
      {
        reconcileProject: vi.fn().mockRejectedValue(new Error('ARGUS_UPSTREAM_CONTRACT_MISMATCH')),
      },
      undefined,
      undefined,
      { reconcile: vi.fn() },
      { now: () => now, jitter: () => 0 }
    );
    await permanentRunner.reconcile(permanent.dir);
    expect(permanent.state.phase).toBe('blocked');
    expect(permanent.state.reconciliation.nextAt).toBeNull();
    expect(permanent.state.reconciliation.reason).toBe('permanent-error');
  });

  it('serializes concurrent externally merged ticks to one completion observation', async () => {
    const { dir, state, service } = await fixture();
    state.activeTask = task(1);
    state.activeTask.phase = 'merge-ready';
    state.activeTask.repository = 'o/r';
    state.activeTask.prNumber = 1;
    state.phase = 'merge-ready';
    const observe = vi.fn(async () => {
      state.activeTask = null;
      state.autonomy = 'satisfied';
      state.phase = 'objective-satisfied';
    });
    const runner = new ArgusAutonomyRunner(
      service,
      { reconcileProject: vi.fn() },
      undefined,
      undefined,
      { reconcile: observe },
      { jitter: () => 0 }
    );
    await Promise.all([1, 2, 3, 4].map(() => runner.reconcile(dir)));
    expect(observe).toHaveBeenCalledOnce();
    expect(state.phase).toBe('objective-satisfied');
  });

  it('routes a terminal Jules repair to Senior diagnosis instead of polling forever', async () => {
    const { dir, state, service } = await fixture();
    state.activeTask = task(1);
    state.activeTask.phase = 'jules-repair';
    state.activeTask.julesSessionId = 'terminal-session';
    state.phase = 'jules-repair';
    const executor = {
      id: 'jules' as const,
      dispatch: vi.fn(),
      reconcile: vi.fn(async (value: ArgusTaskState) => {
        value.julesState = 'COMPLETED';
      }),
    };
    const diagnose = vi.fn(async () => {
      state.activeTask!.phase = 'senior-patch-ready';
      state.phase = 'senior-patch-ready';
    });
    const runner = new ArgusAutonomyRunner(
      service,
      { reconcileProject: vi.fn() },
      executor,
      { reconcile: diagnose },
      { reconcile: vi.fn() },
      { jitter: () => 0 }
    );
    await runner.reconcile(dir);
    expect(executor.reconcile).toHaveBeenCalledOnce();
    expect(diagnose).toHaveBeenCalledOnce();
    expect(state.phase).toBe('senior-patch-ready');
  });

  it('survives restart from persisted CI pending state without duplicating the task', async () => {
    const { dir, state, service } = await fixture();
    state.activeTask = task(1);
    state.activeTask.phase = 'ci-check';
    state.activeTask.repository = 'o/r';
    state.activeTask.prNumber = 1;
    state.phase = 'ci-check';
    state.reconciliation.nextAt = new Date(0).toISOString();
    const observe = vi.fn(async () => {
      state.activeTask!.nextAction = 'observe-ci';
    });
    const first = new ArgusAutonomyRunner(
      service,
      { reconcileProject: vi.fn() },
      undefined,
      { reconcile: observe },
      { reconcile: vi.fn() },
      { jitter: () => 0, setTimer: (() => ({ unref() {} })) as any }
    );
    first.register(dir);
    await first.start();
    first.stop();
    const second = new ArgusAutonomyRunner(
      service,
      { reconcileProject: vi.fn() },
      undefined,
      { reconcile: observe },
      { reconcile: vi.fn() },
      { jitter: () => 0, setTimer: (() => ({ unref() {} })) as any }
    );
    second.register(dir);
    state.reconciliation.nextAt = new Date(0).toISOString();
    await second.start();
    expect(observe).toHaveBeenCalledTimes(2);
    expect(state.activeTask.taskId).toBe('task-1');
    second.stop();
  });

  it.each([
    ['jules-running', 'executor'],
    ['ci-check', 'milestone-d'],
    ['senior-review', 'milestone-d'],
    ['merge-intent', 'milestone-e'],
    ['merged', 'milestone-e'],
    ['done', 'milestone-e'],
  ] as const)('resumes %s through the owning subsystem after restart', async (phase, owner) => {
    const { dir, state, service } = await fixture();
    state.activeTask = task(1);
    state.activeTask.phase = phase;
    state.activeTask.repository = 'o/r';
    state.activeTask.prNumber = 1;
    state.phase = phase;
    state.reconciliation.nextAt = new Date(0).toISOString();
    const executor = { id: 'jules' as const, dispatch: vi.fn(), reconcile: vi.fn() };
    const milestoneD = {
      reconcile: vi.fn(async () => {
        state.activeTask!.phase = 'ci-check';
        state.phase = 'ci-check';
      }),
    };
    const milestoneE = {
      reconcile: vi.fn(async () => {
        state.activeTask!.phase = 'senior-patch-ready';
        state.phase = 'senior-patch-ready';
      }),
    };
    const runner = new ArgusAutonomyRunner(
      service,
      { reconcileProject: vi.fn() },
      executor,
      milestoneD,
      milestoneE,
      { jitter: () => 0, setTimer: (() => ({ unref() {} })) as any }
    );
    runner.register(dir);
    await runner.start();
    expect(
      owner === 'executor'
        ? executor.reconcile
        : owner === 'milestone-d'
          ? milestoneD.reconcile
          : milestoneE.reconcile
    ).toHaveBeenCalledOnce();
    expect(state.activeTask.taskId).toBe('task-1');
    runner.stop();
  });

  it('runs five campaigns with one task, dispatch, and merge each, then becomes permanently quiet', async () => {
    const { dir, state, service } = await fixture();
    const originalCharter = await fs.readFile(path.join(dir, 'ARGUS.md'), 'utf8');
    const taskIds: string[] = [];
    const sessions: string[] = [];
    const merges: string[] = [];
    const externallyMerged = new Set<string>();
    const planner = {
      reconcileProject: vi.fn(async () => {
        const value = task(state.specRevision);
        taskIds.push(value.taskId);
        state.activeTask = value;
        state.phase = value.phase;
        return value;
      }),
    };
    const executor = {
      id: 'jules' as const,
      dispatch: vi.fn(async (value: ArgusTaskState) => {
        value.julesSessionId = `session-${value.sourceSpecRevision}`;
        sessions.push(value.julesSessionId);
        value.phase = 'jules-running';
        state.phase = value.phase;
      }),
      reconcile: vi.fn(async (value: ArgusTaskState) => {
        value.repository = 'o/r';
        value.baseBranch = 'main';
        value.prNumber = value.sourceSpecRevision;
        value.prHeadSha = `head-${value.sourceSpecRevision}`;
        value.phase = 'pr-open';
        state.phase = value.phase;
      }),
    };
    const milestoneD = {
      reconcile: vi.fn(async () => {
        const value = state.activeTask!;
        value.ciHeadSha = value.prHeadSha;
        value.ciState = 'success';
        value.reviewedHeadSha = value.prHeadSha;
        value.reviewVerdict = 'approve';
        value.phase = 'merge-ready';
        state.phase = value.phase;
      }),
    };
    const milestoneE = {
      reconcile: vi.fn(async () => {
        if (!externallyMerged.has(state.activeTask!.taskId)) {
          state.activeTask!.nextAction = 'human-merge-required';
          return;
        }
        const revision = state.activeTask!.sourceSpecRevision;
        merges.push(state.activeTask!.taskId);
        if (revision === 5) {
          state.activeTask = null;
          state.autonomy = 'satisfied';
          state.phase = 'objective-satisfied';
        } else {
          state.specRevision = revision + 1;
          state.activeTask = null;
          state.phase = 'planning';
        }
      }),
    };
    const runner = new ArgusAutonomyRunner(service, planner, executor, milestoneD, milestoneE, {
      jitter: () => 0,
    });
    for (let wake = 0; wake < 25 && state.autonomy === 'enabled'; wake++) {
      if (state.activeTask?.nextAction === 'human-merge-required')
        externallyMerged.add(state.activeTask.taskId);
      await runner.wake(dir, `campaign-${state.specRevision}`);
    }
    expect(taskIds).toEqual(['task-1', 'task-2', 'task-3', 'task-4', 'task-5']);
    expect(sessions).toEqual(['session-1', 'session-2', 'session-3', 'session-4', 'session-5']);
    expect(merges).toEqual(taskIds);
    expect(state.specRevision).toBe(5);
    expect(state.autonomy).toBe('satisfied');
    expect(state.reconciliation.nextAt).toBeNull();
    expect(await fs.readFile(path.join(dir, 'ARGUS.md'), 'utf8')).toBe(originalCharter);
  });
});

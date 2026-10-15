import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ArgusCampaignManager } from '../../../src/services/argus/campaigns.js';
import { ArgusAutonomyRunner } from '../../../src/services/argus/autonomy-runner.js';
import { TaskHistoryStore } from '../../../src/services/argus/task-history.js';
import {
  ensureArgusControlFiles,
  resolveState,
} from '../../../src/services/argus/project-lifecycle.js';
import type { ArgusTaskState } from '../../../src/services/argus/types.js';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'campaign-'));
  dirs.push(dir);
  await ensureArgusControlFiles(dir, '# campaign', '# objective');
  const state = await resolveState('project', dir, 'mock');
  return { dir, state };
}
function task(id: string): ArgusTaskState {
  return {
    taskId: id,
    featureId: id,
    phase: 'awaiting-executor',
    executor: 'jules',
    julesRepairAttempt: 0,
    seniorGuidedRepairAttempt: 0,
    prHeadSha: null,
    mergeCommitSha: null,
    localSyncedSha: null,
    prNumber: null,
    blockedReason: null,
    ciState: 'unknown',
    events: [],
  } as unknown as ArgusTaskState;
}
describe('durable campaign budgets', () => {
  it('serializes simultaneous starts and recovers the original eight-hour deadline', async () => {
    const { dir } = await fixture();
    let now = Date.parse('2026-10-01T00:00:00Z');
    const manager = new ArgusCampaignManager(() => now);
    const [a, b] = await Promise.all([manager.start(dir, 'p'), manager.start(dir, 'p')]);
    expect(a.id).toBe(b.id);
    expect(Date.parse(a.deadlineAt) - now).toBe(8 * 3600000);
    expect(Date.parse(a.drainAt) - now).toBe(7.5 * 3600000);
    now += 4 * 3600000;
    const restarted = new ArgusCampaignManager(() => now);
    expect((await restarted.start(dir, 'p')).deadlineAt).toBe(a.deadlineAt);
  });
  it('runs multiple cycles, drains without new dispatch, and reports exact persisted outcomes', async () => {
    const { dir, state } = await fixture();
    let now = 0;
    const history = new TaskHistoryStore();
    const manager = new ArgusCampaignManager(() => now, history);
    await manager.start(dir, 'p');
    for (const id of ['one', 'two']) {
      const t = task(id);
      expect(await manager.reserveTask(dir, t)).toBe(true);
      t.phase = 'done';
      t.mergeCommitSha = id.repeat(40).slice(0, 40);
      t.localSyncedSha = t.mergeCommitSha;
      t.prNumber = id === 'one' ? 1 : 2;
      await history.archive(dir, t, 'completed');
      state.activeTask = null;
      await manager.observe(dir, state);
    }
    now = 7.5 * 3600000;
    expect((await manager.beforeCycle(dir, state)).allowNewTasks).toBe(false);
    expect(await manager.reserveTask(dir, task('three'))).toBe(false);
    now = 8 * 3600000;
    expect((await manager.beforeCycle(dir, state)).allowReconcile).toBe(false);
    const report = await manager.report(dir, undefined, state);
    expect(report.status).toBe('completed');
    expect(report.tasksCompleted).toBe(2);
    expect(report.prsMerged).toBe(2);
    expect(report.taskOutcomes[0].mergeSha).toBeTruthy();
  });
  it('persists pause/resume without extending deadlines and expires without killing remote work', async () => {
    const { dir, state } = await fixture();
    let now = 0;
    const manager = new ArgusCampaignManager(() => now);
    const initial = await manager.start(dir, 'p', { durationMs: 10000, drainMs: 1000 });
    await manager.change(dir, 'pause');
    expect((await manager.beforeCycle(dir, state)).allowReconcile).toBe(false);
    now = 3000;
    await manager.change(dir, 'resume');
    expect((await manager.current(dir))?.deadlineAt).toBe(initial.deadlineAt);
    state.activeTask = task('remote');
    state.activeTask.phase = 'jules-running';
    state.activeTask.julesSessionId = 'existing-session';
    now = 10000;
    await manager.beforeCycle(dir, state);
    expect((await manager.current(dir))?.status).toBe('expired');
    expect(state.activeTask.julesSessionId).toBe('existing-session');
    expect((await manager.report(dir, undefined, state)).pendingTasks).toContain('remote');
  });
  it('caps new tasks and repairs and blocks repeated infrastructure failures honestly', async () => {
    const { dir, state } = await fixture();
    const manager = new ArgusCampaignManager(() => 0);
    await manager.start(dir, 'p', { maxNewTasks: 1, maxRepairAttempts: 1 });
    const t = task('one');
    await manager.reserveTask(dir, t);
    expect(await manager.reserveTask(dir, task('two'))).toBe(false);
    t.julesRepairAttempt = 1;
    expect(await manager.allowRepair(dir, t)).toBe(false);
    state.activeTask = t;
    t.blockedReason = 'EXECUTOR_UNAVAILABLE';
    await manager.observe(dir, state);
    expect((await manager.current(dir))?.status).toBe('blocked');
  });
  it('keeps the sole runner from planning or dispatching during drain or after expiry', async () => {
    const { dir, state } = await fixture();
    let now = 0;
    const campaigns = new ArgusCampaignManager(() => now);
    await campaigns.start(dir, 'p', { durationMs: 10000, drainMs: 1000 });
    const planner = { reconcileProject: vi.fn() };
    const dispatch = vi.fn();
    const remoteReconcile = vi.fn();
    const runner = new ArgusAutonomyRunner(
      { getStatus: async () => state } as any,
      planner,
      { dispatch, reconcile: remoteReconcile } as any,
      undefined,
      { reconcile: vi.fn() },
      { now: () => now, campaigns }
    );
    state.autonomy = 'enabled';
    state.phase = 'planning';
    now = 9000;
    await runner.reconcile(dir);
    expect(planner.reconcileProject).not.toHaveBeenCalled();
    state.phase = 'awaiting-executor';
    state.activeTask = task('pending');
    await runner.reconcile(dir);
    expect(dispatch).not.toHaveBeenCalled();
    now = 10000;
    await runner.reconcile(dir);
    expect(remoteReconcile).not.toHaveBeenCalled();
    expect(state.reconciliation.nextAt).toBeNull();
  });
  it('does not reapply a handled resume over objective satisfaction', async () => {
    const { dir, state } = await fixture();
    const runner = new ArgusAutonomyRunner(
      { getStatus: async () => state } as any,
      { reconcileProject: vi.fn() },
      undefined,
      undefined,
      { reconcile: vi.fn() }
    );
    await runner.requestReconcile(dir, 'resume', 'resume');
    state.phase = 'objective-satisfied';
    await runner.reconcile(dir);
    state.autonomy = 'satisfied';
    await runner.reconcile(dir);
    expect(state.autonomy).toBe('satisfied');
  });
});
it('rejects nested metadata symlinks before campaign persistence', async () => {
  const { dir } = await fixture();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'campaign-outside-'));
  dirs.push(outside);
  await fs.symlink(outside, path.join(dir, '.automaker', 'campaigns'));
  await expect(new ArgusCampaignManager().start(dir, 'p')).rejects.toThrow('SYMLINK_REFUSED');
  expect(await fs.readdir(outside)).toEqual([]);
});
it('accelerates a full eight-hour Runner campaign across restart with one dispatch per task', async () => {
  const { dir, state } = await fixture();
  let now = 0;
  let sequence = 0;
  const history = new TaskHistoryStore();
  let campaigns = new ArgusCampaignManager(() => now, history);
  await campaigns.start(dir, 'p', { maxNewTasks: 3 });
  state.autonomy = 'enabled';
  state.phase = 'planning';
  const planner = {
    reconcileProject: vi.fn(async () => {
      state.activeTask = task(`cycle-${++sequence}`);
      state.phase = 'awaiting-executor';
      return state.activeTask;
    }),
  };
  const executor = {
    dispatch: vi.fn(async (t: ArgusTaskState) => {
      t.julesSessionId = `session-${t.taskId}`;
      t.phase = 'jules-running';
      state.phase = t.phase;
    }),
    reconcile: vi.fn(async (t: ArgusTaskState) => {
      t.prNumber = sequence;
      t.phase = 'merge-ready';
      state.phase = t.phase;
    }),
  };
  const merge = {
    reconcile: vi.fn(async () => {
      const t = state.activeTask!;
      t.mergeCommitSha = 'a'.repeat(40);
      t.localSyncedSha = t.mergeCommitSha;
      await history.archive(dir, t, 'completed');
      state.activeTask = null;
      state.phase = 'planning';
    }),
  };
  const service = { getStatus: async () => state } as any;
  let runner = new ArgusAutonomyRunner(service, planner, executor as any, undefined, merge, {
    campaigns,
    now: () => now,
  });
  await runner.reconcile(dir);
  now = 4 * 3600000;
  campaigns = new ArgusCampaignManager(() => now, history);
  runner = new ArgusAutonomyRunner(service, planner, executor as any, undefined, merge, {
    campaigns,
    now: () => now,
  });
  await runner.reconcile(dir);
  expect(executor.dispatch).toHaveBeenCalledTimes(3);
  expect(sequence).toBe(3);
  now = 7.5 * 3600000;
  await runner.reconcile(dir);
  expect((await campaigns.current(dir))?.status).toBe('draining');
  now = 8 * 3600000;
  await runner.reconcile(dir);
  const report = await campaigns.report(dir, undefined, state);
  expect(report.status).toBe('completed');
  expect(report.tasksCompleted).toBe(3);
  expect(executor.dispatch).toHaveBeenCalledTimes(3);
  expect(new Set(executor.dispatch.mock.calls.map(([t]) => t.taskId)).size).toBe(3);
});
it('redacts archived and reported failures using configured credential values', async () => {
  const { dir, state } = await fixture();
  const secret = 'campaign-fixture-private-value';
  vi.stubEnv('COMPATIBLE_API_KEY', secret);
  try {
    const t = task('redaction');
    t.blockedReason = `failure ${secret}`;
    const history = new TaskHistoryStore();
    await history.archive(dir, t, 'blocked');
    expect(
      await fs.readFile(path.join(dir, '.automaker', 'task-history.json'), 'utf8')
    ).not.toContain(secret);
    const manager = new ArgusCampaignManager(() => 0, history);
    await manager.start(dir, 'p');
    await manager.reserveTask(dir, t);
    state.activeTask = t;
    expect(JSON.stringify(await manager.report(dir, undefined, state))).not.toContain(secret);
  } finally {
    vi.unstubAllEnvs();
  }
});

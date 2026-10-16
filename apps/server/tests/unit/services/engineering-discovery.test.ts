import { afterEach, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { EngineeringScout } from '../../../src/services/argus/engineering-scout.js';
import { EngineeringExperiments } from '../../../src/services/argus/engineering-experiments.js';
import { ArgusOrchestrator } from '../../../src/services/argus/orchestrator.js';
import { TaskHistoryStore } from '../../../src/services/argus/task-history.js';
import { FeatureLoader } from '../../../src/services/feature-loader.js';
import {
  ensureArgusControlFiles,
  resolveState,
} from '../../../src/services/argus/project-lifecycle.js';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});
async function fixture(gap?: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scout-'));
  dirs.push(root);
  await ensureArgusControlFiles(root, '# tests', '# improve reliability');
  const state = await resolveState('p', root, 'mock');
  state.autonomy = 'satisfied';
  state.phase = 'objective-satisfied';
  const argus = {
    getStatus: async () => state,
    managerHandoff: vi.fn(async () => ({
      admitted: true,
      reason: 'measured gap relevant to objective',
      evidence: ['current verification gap'],
      recommendedExecutor: 'junior',
    })),
    plannerNextTask: vi.fn(async () => ({
      taskId: 'irrelevant-model-id',
      description: 'test',
      objective: 'reliability',
      dependencies: [],
      sourceSpecRevision: 1,
      evidenceRequired: ['test output'],
      acceptanceCriteria: ['tests pass'],
      recommendedExecutor: 'junior',
      title: 'measured improvement',
      risk: 'normal',
    })),
  } as any;
  if (gap)
    await new TaskHistoryStore().archive(
      root,
      {
        taskId: 'old',
        featureId: 'old',
        julesRepairAttempt: 0,
        seniorGuidedRepairAttempt: 0,
        prHeadSha: 'a'.repeat(40),
        lokiEvidence: { notProven: [gap] },
      } as any,
      'completed'
    );
  const ideas = { createIdea: vi.fn(async () => ({ id: 'idea' })) } as any;
  const planner = new ArgusOrchestrator(argus, new FeatureLoader());
  return { root, state, argus, ideas, planner };
}
it('objective completion discovers an evidence-backed test, Manager admits it, mock completion returns to quiescence', async () => {
  const { root, state, argus, ideas, planner } = await fixture(
    'Concurrent wake lacks a discriminating regression assertion'
  );
  const scout = new EngineeringScout(argus, planner, ideas, true);
  expect(await scout.discover(root)).toBe(true);
  expect(argus.managerHandoff.mock.calls[0][1].improvementHypothesis.sourceEvidence).toHaveLength(
    3
  );
  expect(state.activeTask?.title).toMatch(/^Test:/);
  expect(state.activeTask?.evidenceRequired.join(' ')).toContain('negative control');
  const t = state.activeTask!;
  t.mergeCommitSha = 'b'.repeat(40);
  t.localSyncedSha = t.mergeCommitSha;
  await new TaskHistoryStore().archive(root, t, 'completed');
  state.activeTask = null;
  state.autonomy = 'satisfied';
  state.phase = 'objective-satisfied';
  expect(await scout.discover(root)).toBe(false);
  expect((await scout.status(root))?.status).toBe('QUIESCENT');
  expect(ideas.createIdea).toHaveBeenCalledOnce();
});
it('evidence-poor objective produces NO_ACTION without model calls or executable tasks', async () => {
  const f = await fixture();
  const scout = new EngineeringScout(f.argus, f.planner, f.ideas, true);
  expect(await scout.discover(f.root)).toBe(false);
  expect((await scout.status(f.root))?.reason).toBe('NO_ACTION');
  expect(f.argus.managerHandoff).not.toHaveBeenCalled();
  expect(f.state.activeTask).toBeNull();
});
it('disabled discovery and sensitive proposals never execute', async () => {
  const f = await fixture('Authentication policy has no tests');
  expect(await new EngineeringScout(f.argus, f.planner, f.ideas, false).discover(f.root)).toBe(
    false
  );
  const scout = new EngineeringScout(f.argus, f.planner, f.ideas, true);
  await scout.discover(f.root);
  expect((await scout.status(f.root))?.hypotheses[0].disposition).toBe('human-approval');
  expect(f.argus.managerHandoff).not.toHaveBeenCalled();
  expect(f.state.activeTask).toBeNull();
});
it('Manager rejection and empty admission evidence cannot become executable', async () => {
  const f = await fixture('Missing error-path assertion');
  f.argus.managerHandoff.mockResolvedValue({
    admitted: true,
    evidence: [],
    recommendedExecutor: 'junior',
  });
  await new EngineeringScout(f.argus, f.planner, f.ideas, true).discover(f.root);
  expect(f.argus.plannerNextTask).not.toHaveBeenCalled();
  expect(f.state.activeTask).toBeNull();
});
const input = () => ({
  hypothesisId: 'h',
  baseline: { value: 100, headSha: 'a'.repeat(40) },
  metric: 'latency-ms',
  direction: 'min' as const,
  minimumImprovement: 10,
  commands: ['npm test'],
  variants: [
    { id: 'one', branch: 'experiment/one', headSha: 'b'.repeat(40) },
    { id: 'two', branch: 'experiment/two', headSha: 'c'.repeat(40) },
  ],
});
it('selects only a measured isolated exact-SHA winner and never dispatches variants to the normal pipeline', async () => {
  const { root } = await fixture();
  const experiments = new EngineeringExperiments({
    evaluate: async (job) => ({
      runId: job.runId,
      headSha: job.variant.headSha,
      isolated: true,
      correctness: true,
      value: job.variant.id === 'baseline' ? 100 : job.variant.id === 'one' ? 50 : 80,
      artifact: 'artifact:test',
    }),
  });
  const e = await experiments.create(root, input());
  const result = await experiments.evaluate(root, e.id);
  expect(result.winner).toBe('one');
  expect((await experiments.selected(root, e.id))?.branch).toBe('experiment/one');
  await expect(experiments.evaluate(root, e.id)).rejects.toThrow('ALREADY_CLAIMED');
});
it('unavailable, stale, tied or incorrect experiment measurements are inconclusive', async () => {
  for (const mode of ['unavailable', 'stale', 'tie', 'incorrect']) {
    const { root } = await fixture();
    const experiments = new EngineeringExperiments(
      mode === 'unavailable'
        ? undefined
        : {
            evaluate: async (job) => ({
              runId: job.runId,
              headSha: mode === 'stale' ? 'd'.repeat(40) : job.variant.headSha,
              isolated: true,
              correctness: mode !== 'incorrect',
              value: 50,
              artifact: 'artifact:test',
            }),
          }
    );
    const e = await experiments.create(root, input());
    expect((await experiments.evaluate(root, e.id)).status).toBe('inconclusive');
    expect(await experiments.selected(root, e.id)).toBeUndefined();
  }
});
it('admits only the selected experiment SHA through Manager and normal task gates', async () => {
  const f = await fixture();
  const experiments = new EngineeringExperiments({
    evaluate: async (job) => ({
      runId: job.runId,
      headSha: job.variant.headSha,
      isolated: true,
      correctness: true,
      value: job.variant.id === 'baseline' ? 100 : job.variant.id === 'one' ? 50 : 80,
      artifact: 'artifact:test',
    }),
  });
  const e = await experiments.create(f.root, input());
  await experiments.evaluate(f.root, e.id);
  const admitted = await experiments.admitWinner(f.root, e.id, f.argus, f.planner);
  expect(admitted?.phase).toBe('awaiting-executor');
  expect(admitted?.selectedVariantSha).toBe('b'.repeat(40));
  expect(admitted?.description).toContain('ONLY selected variant');
  f.state.activeTask = null;
  await expect(
    f.planner.admitPlannedTask(f.root, {
      ...admitted!,
      taskId: 'attempt-loser',
      experimentId: e.id,
      selectedVariantSha: 'c'.repeat(40),
    })
  ).rejects.toThrow('WINNER_REQUIRED');
});

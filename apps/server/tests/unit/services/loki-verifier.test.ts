import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  LokiVerifier,
  VerificationEvidenceStore,
  RemoteLokiExecutor,
} from '../../../src/services/argus/verification.js';
import { FeatureLoader } from '../../../src/services/feature-loader.js';

async function enableFixtureAutonomy(
  argus: SupervisedArgusService,
  projectPath: string
): Promise<void> {
  await argus.resumeProject(projectPath);
  const state = await argus.getStatus(projectPath);
  if (!state) throw new Error('TEST_ARGUS_STATE_MISSING');
  if (state.autonomy !== 'paused') throw new Error(`TEST_EXPECTED_PAUSED_STATE: ${state.autonomy}`);
  state.autonomy = 'enabled';
  await saveArgusState(projectPath, state);
}

import {
  SupervisedArgusService,
  ensureArgusControlFiles,
  ArgusOrchestrator,
  MilestoneDOrchestrator,
  saveArgusState,
} from '../../../src/services/argus/index.js';
const head = 'a'.repeat(40),
  base = 'b'.repeat(40),
  fresh = 'c'.repeat(40);
const input = { taskId: 'task', repository: 'o/r', prNumber: 7, headSha: head, baseSha: base };
const policy = { enabled: true, requiredForMerge: true, maxRepairAttempts: 2, timeoutMs: 1000 };
const raw = (sha = head, reasons: string[] = []) => ({
  pr: { repo: 'o/r', number: 7 },
  head: sha,
  base,
  verdict: reasons.length ? 'NOT PROVEN' : 'VERIFIED',
  checks: ['npm test'],
  reasons,
  blocked: false,
});
const executor = (result: any = raw(), extra: any = {}) => ({
  isolation: 'external-sandbox' as const,
  execute: vi.fn(async (job: any) => ({
    runId: job.runId,
    sandboxVerified: true,
    exitCode: result.verdict === 'VERIFIED' ? 0 : 4,
    result,
    ...extra,
  })),
});
const dirs: string[] = [];
const services: SupervisedArgusService[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(services.splice(0).map((s) => s.stop()));
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'loki-lifecycle-'));
  dirs.push(dir);
  await ensureArgusControlFiles(dir, '# spec', '# objective');
  vi.stubEnv('ARGUS_BRIDGE_FAKE', '1');
  const argus = new SupervisedArgusService(path.resolve('scripts/argus_runtime_bridge.py'));
  services.push(argus);
  await argus.start();
  await argus.createOrResolveProject({ projectPath: dir, projectId: 'p', model: 'opencode/model' });
  await enableFixtureAutonomy(argus, dir);
  const features = new FeatureLoader();
  const task = (await new ArgusOrchestrator(argus, features).reconcileProject(dir))!;
  Object.assign(task, {
    repository: 'o/r',
    baseBranch: 'main',
    prNumber: 7,
    prHeadSha: head,
    phase: 'pr-open',
    julesSessionId: 'same-session',
    julesState: 'IN_PROGRESS',
  });
  return { dir, argus, features, task };
}
const pr = (sha = head) => ({
  number: 7,
  repository: 'o/r',
  state: 'OPEN',
  headSha: sha,
  baseSha: base,
  baseBranch: 'main',
});
describe('Loki external verification', () => {
  it('constructs only the documented CLI command and persists exact-head evidence', async () => {
    const exec = executor();
    const result = await new LokiVerifier(exec, policy).verify(input);
    expect(result.verdict).toBe('VERIFIED');
    expect(exec.execute.mock.calls[0][0].args.slice(0, 3)).toEqual([
      'verify-pr',
      'https://github.com/o/r/pull/7',
      '--out',
    ]);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'loki-evidence-'));
    dirs.push(dir);
    const store = new VerificationEvidenceStore();
    await store.save(dir, result);
    expect((await store.read(dir, input.taskId, head))?.headSha).toBe(head);
    expect(await store.read(dir, input.taskId, fresh)).toBeUndefined();
  });
  it('never treats a missing sandbox, stale run or stale SHA as verification', async () => {
    expect((await new LokiVerifier(undefined, policy).verify(input)).verdict).toBe('UNAVAILABLE');
    expect(
      (await new LokiVerifier(executor(raw(), { sandboxVerified: false }), policy).verify(input))
        .verdict
    ).toBe('UNAVAILABLE');
    expect(
      (await new LokiVerifier(executor(raw(), { runId: 'old-run' }), policy).verify(input)).verdict
    ).toBe('UNAVAILABLE');
    expect((await new LokiVerifier(executor(raw(fresh)), policy).verify(input)).verdict).toBe(
      'NOT_PROVEN'
    );
  });
  it('bounds timeouts and redacts findings', async () => {
    const pending = {
      isolation: 'external-sandbox' as const,
      execute: () => new Promise<any>(() => {}),
    };
    expect(
      (await new LokiVerifier(pending, { ...policy, timeoutMs: 5 }).verify(input)).verdict
    ).toBe('ERROR');
    vi.stubEnv('COMPATIBLE_API_KEY', 'fixture-secret');
    const result = await new LokiVerifier(
      executor(raw(head, ['check still fails on head: fixture-secret'])),
      policy
    ).verify(input);
    expect(result.verdict).toBe('FAILED');
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
  });
  it('refuses non-TLS worker endpoints and bounds response payloads', async () => {
    expect(() => new RemoteLokiExecutor('http://worker.test', 'fixture')).toThrow('TLS_REQUIRED');
    const remote = new RemoteLokiExecutor(
      'https://worker.test',
      'fixture',
      vi.fn(async () => new Response('x'.repeat(70000))) as any
    );
    await expect(
      remote.execute({ ...input, runId: 'run', command: 'loki', args: [], timeoutMs: 1000 })
    ).rejects.toThrow('TOO_LARGE');
  });
});
describe('Loki lifecycle in Milestone D', () => {
  it('repairs one PR in the same live Jules session, waits for a new head, and then reaches merge-ready', async () => {
    const { dir, argus, features, task } = await fixture();
    let current = head;
    const worker = executor();
    worker.execute.mockImplementation(async (job: any) => ({
      runId: job.runId,
      sandboxVerified: true,
      exitCode: job.headSha === head ? 4 : 0,
      result: raw(
        job.headSha,
        job.headSha === head ? ['check still fails on head (exit 1): npm test'] : []
      ),
    }));
    const jules = {
      getSession: vi.fn(async () => ({ state: 'IN_PROGRESS' })),
      sendMessage: vi.fn(async () => {}),
      createTaskSession: vi.fn(),
    };
    const github = {
      getPullRequest: vi.fn(async () => pr(current)),
      observe: vi.fn(async () => ({
        headSha: current,
        state: 'success',
        observedAt: new Date().toISOString(),
        runIds: ['ci'],
        failures: [],
      })),
      getPullRequestDiff: vi.fn(async () => 'safe fixture'),
    };
    const senior = {
      review: vi.fn(async () => ({
        result: {
          verdict: 'approve',
          reviewedHeadSha: current,
          findings: [],
          requiredChanges: [],
          evidence: ['review'],
        },
      })),
      diagnose: vi.fn(),
    };
    const d = new MilestoneDOrchestrator(
      argus,
      features,
      github as any,
      jules as any,
      senior as any,
      undefined,
      new LokiVerifier(worker, policy)
    );
    await d.reconcile(dir);
    expect(task.phase).toBe('jules-repair');
    expect(task.lokiRepairAttempts).toBe(1);
    expect(jules.sendMessage).toHaveBeenCalledTimes(1);
    await d.reconcile(dir);
    expect(jules.sendMessage).toHaveBeenCalledTimes(1);
    current = fresh;
    await d.reconcile(dir);
    expect(task.lokiEvidence?.verdict).toBe('VERIFIED');
    expect(task.lokiEvidence?.headSha).toBe(fresh);
    expect(task.phase).toBe('merge-ready');
    expect(task.julesSessionId).toBe('same-session');
    expect(task.prNumber).toBe(7);
    expect(jules.createTaskSession).not.toHaveBeenCalled();
  });
  it('refreshes terminal Jules state before repair and escalates without creating a replacement session', async () => {
    const { dir, argus, features, task } = await fixture();
    const jules = {
      getSession: vi.fn(async () => ({ state: 'COMPLETED' })),
      sendMessage: vi.fn(),
      createTaskSession: vi.fn(),
    };
    const github = {
      getPullRequest: vi.fn(async () => pr()),
      getPullRequestDiff: vi.fn(async () => 'diff'),
    };
    const senior = {
      diagnose: vi.fn(async () => ({
        result: {
          rootCause: 'test',
          recommendedFix: 'bounded fix',
          juniorCanRepair: true,
          evidence: [],
          filesLikelyAffected: [],
        },
      })),
    };
    await new MilestoneDOrchestrator(
      argus,
      features,
      github as any,
      jules as any,
      senior as any,
      undefined,
      new LokiVerifier(executor(raw(head, ['check still fails on head: npm test'])), policy)
    ).reconcile(dir);
    expect(task.phase).toBe('senior-takeover');
    expect(jules.sendMessage).not.toHaveBeenCalled();
    expect(jules.createTaskSession).not.toHaveBeenCalled();
  });
  it('rejects a head changed during verification and recovers durable repair intent without sending twice', async () => {
    const { dir, argus, features, task } = await fixture();
    let calls = 0;
    const github = { getPullRequest: vi.fn(async () => pr(++calls === 1 ? head : fresh)) };
    const jules = { getSession: vi.fn(), sendMessage: vi.fn() };
    await new MilestoneDOrchestrator(
      argus,
      features,
      github as any,
      jules as any,
      {} as any,
      undefined,
      new LokiVerifier(executor(), policy)
    ).reconcile(dir);
    expect(task.lokiEvidence).toBeNull();
    expect(task.phase).toBe('ci-check');
    expect(task.prHeadSha).toBe(fresh);
  });
  it('blocks required verification when an isolated worker is unavailable', async () => {
    const { dir, argus, features, task } = await fixture();
    await new MilestoneDOrchestrator(
      argus,
      features,
      { getPullRequest: async () => pr() } as any,
      {} as any,
      {} as any,
      undefined,
      new LokiVerifier(undefined, policy)
    ).reconcile(dir);
    expect(task.phase).toBe('blocked');
    expect(task.blockedReason).toBe('LOKI_UNAVAILABLE');
  });
});

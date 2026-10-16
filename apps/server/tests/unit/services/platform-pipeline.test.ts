import { afterEach, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { FeatureLoader } from '../../../src/services/feature-loader.js';
import {
  ensureArgusControlFiles,
  SupervisedArgusService,
  ArgusOrchestrator,
  JulesDeveloperAdapter,
  MilestoneDOrchestrator,
  MilestoneEOrchestrator,
  GitIntegrationService,
} from '../../../src/services/argus/index.js';
import { LokiVerifier } from '../../../src/services/argus/verification.js';
const dirs: string[] = [];
const services: SupervisedArgusService[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(services.splice(0).map((s) => s.stop()));
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});
it('one Jules session and PR survive Loki repair, fresh verification, CI, Senior approval and confirmed merge', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-platform-'));
  dirs.push(dir);
  vi.stubEnv('ARGUS_BRIDGE_FAKE', '1');
  await ensureArgusControlFiles(dir, '# bounded task', '# stable objective');
  const argus = new SupervisedArgusService(path.resolve('scripts/argus_runtime_bridge.py'));
  services.push(argus);
  await argus.start();
  await argus.createOrResolveProject({ projectId: 'p', projectPath: dir, model: 'opencode/model' });
  await argus.resumeProject(dir);
  const features = new FeatureLoader();
  const task = (await new ArgusOrchestrator(argus, features).reconcileProject(dir))!;
  const base = 'b'.repeat(40),
    old = 'a'.repeat(40),
    fresh = 'c'.repeat(40),
    merged = 'd'.repeat(40);
  let current = old,
    done = false;
  const jules = {
    findRepositorySource: vi.fn(async () => ({ name: 'sources/o/r' })),
    listSessions: vi.fn(async () => []),
    createTaskSession: vi.fn(async () => ({ id: 'one-session', state: 'IN_PROGRESS' })),
    getSession: vi.fn(async () => ({ id: 'one-session', state: 'IN_PROGRESS' })),
    reconcileSession: vi.fn(async () => ({
      session: { id: 'one-session', state: 'IN_PROGRESS' },
      activities: [],
      pullRequest: { url: 'https://github.com/o/r/pull/7' },
    })),
    sendMessage: vi.fn(async () => {}),
  };
  const builder = new JulesDeveloperAdapter(jules as any, argus, features, {
    autoMonitor: false,
    captureGit: async () =>
      ({
        repository: 'o/r',
        baseBranch: 'main',
        baseRemoteSha: base,
        localSha: base,
        remoteUrl: 'https://github.com/o/r.git',
      }) as any,
    verifyPr: async () =>
      ({
        number: 7,
        url: 'https://github.com/o/r/pull/7',
        headSha: current,
        branch: 'jules/task',
      }) as any,
  });
  await builder.dispatch(task, dir);
  await builder.reconcile(task, dir);
  expect(task.julesSessionId).toBe('one-session');
  const pr = () => ({
    number: 7,
    state: done ? 'CLOSED' : 'OPEN',
    repository: 'o/r',
    url: 'https://github.com/o/r/pull/7',
    baseBranch: 'main',
    baseSha: base,
    headBranch: 'jules/task',
    headSha: current,
    merged: done,
    mergeCommitSha: done ? merged : null,
  });
  const github = {
    getPullRequest: vi.fn(async () => pr()),
    getPullRequestDiff: vi.fn(async () => 'bounded fixture'),
    observe: vi.fn(async (_: string, sha: string) => ({
      headSha: sha,
      state: 'success',
      observedAt: new Date().toISOString(),
      runIds: ['ci'],
      failures: [],
    })),
    mergePullRequest: vi.fn(async (_: string, __: number, expected: string) => {
      expect(expected).toBe(fresh);
      done = true;
      return { merged: true, sha: merged };
    }),
  };
  const worker = {
    isolation: 'external-sandbox' as const,
    execute: vi.fn(async (job: any) => ({
      runId: job.runId,
      sandboxVerified: true,
      exitCode: job.headSha === old ? 4 : 0,
      result: {
        pr: { repo: 'o/r', number: 7 },
        base,
        head: job.headSha,
        verdict: job.headSha === old ? 'NOT PROVEN' : 'VERIFIED',
        checks: ['npm test'],
        reasons: job.headSha === old ? ['check still fails on head (exit 1): npm test'] : [],
        blocked: false,
      },
    })),
  };
  const senior = {
    review: vi.fn(async () => ({
      result: {
        verdict: 'approve',
        reviewedHeadSha: current,
        findings: [],
        requiredChanges: [],
        evidence: ['independent review'],
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
    new LokiVerifier(worker, {
      enabled: true,
      requiredForMerge: true,
      maxRepairAttempts: 2,
      timeoutMs: 1000,
    })
  );
  await d.reconcile(dir);
  expect(task.phase).toBe('jules-repair');
  expect(jules.sendMessage).toHaveBeenCalledTimes(1);
  // The authoritative task state and repair intent survive a real bridge restart.
  await argus.stop();
  const restarted = new SupervisedArgusService(path.resolve('scripts/argus_runtime_bridge.py'));
  services.push(restarted);
  await restarted.start();
  await restarted.createOrResolveProject({
    projectId: 'p',
    projectPath: dir,
    model: 'opencode/model',
  });
  await restarted.resumeProject(dir);
  const loaded = (await restarted.getStatus(dir))!.activeTask!;
  expect(loaded.lokiRepairIntent?.sessionId).toBe('one-session');
  const recovered = new MilestoneDOrchestrator(
    restarted,
    features,
    github as any,
    jules as any,
    senior as any,
    undefined,
    new LokiVerifier(worker, {
      enabled: true,
      requiredForMerge: true,
      maxRepairAttempts: 2,
      timeoutMs: 1000,
    })
  );
  await recovered.reconcile(dir);
  expect(jules.sendMessage).toHaveBeenCalledTimes(1);
  current = fresh;
  await recovered.reconcile(dir);
  expect(loaded.phase).toBe('merge-ready');
  const local = {
    synchronize: vi.fn(async () => ({
      currentBranch: 'main',
      localHead: merged,
      remoteHead: merged,
      remoteContainsMerge: true,
      dirty: false,
      localAhead: false,
      recoveryRef: null,
      recoveryReason: null,
      recoveryOriginalHead: null,
      recoveryCreatedAt: null,
      recoverySnapshots: [],
    })),
    fetchAndInspect: vi.fn(async () => ({
      currentBranch: 'main',
      localHead: merged,
      remoteHead: merged,
      remoteContainsMerge: true,
      dirty: false,
      localAhead: false,
    })),
  };
  const coordination = {
    prepare: (t: any) => ({
      owner: 'fixture-owner',
      reference: 'tags/fixture',
      tagSha: base,
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      repository: t.repository,
      baseBranch: t.baseBranch,
    }),
    acquire: vi.fn(async () => {}),
    assertCurrentBase: vi.fn(async (t: any) => {
      expect(t.lokiEvidence.headSha).toBe(fresh);
      expect(t.ciHeadSha).toBe(fresh);
      expect(t.reviewedHeadSha).toBe(fresh);
    }),
    release: vi.fn(async () => {}),
  };
  await new MilestoneEOrchestrator(
    restarted,
    features,
    new GitIntegrationService(github as any, local as any, coordination)
  ).reconcile(dir);
  expect(jules.createTaskSession).toHaveBeenCalledTimes(1);
  expect(jules.sendMessage).toHaveBeenCalledTimes(1);
  expect(github.mergePullRequest).toHaveBeenCalledTimes(1);
  expect((await features.get(dir, loaded.featureId))?.status).toBe('verified');
  expect(loaded.mergeCommitSha).toBe(merged);
  expect(loaded.localSyncedSha).toBe(merged);
  expect(coordination.release).toHaveBeenCalledTimes(1);
});

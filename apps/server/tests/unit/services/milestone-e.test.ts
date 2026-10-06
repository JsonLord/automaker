import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { FeatureLoader } from '../../../src/services/feature-loader.js';
import {
  ArgusOrchestrator,
  CommandLocalGitAdapter,
  GitIntegrationService,
  MilestoneEOrchestrator,
  SpecRenewalService,
  SupervisedArgusService,
  assertDoneInvariant,
  ensureArgusControlFiles,
  resolveState,
} from '../../../src/services/argus/index.js';

const dirs: string[] = [];
afterEach(async () => {
  delete process.env.ARGUS_BRIDGE_FAKE;
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'milestone-e-'));
  dirs.push(dir);
  await ensureArgusControlFiles(dir, '# Campaign one', '# Stable objective');
  process.env.ARGUS_BRIDGE_FAKE = '1';
  const argus = new SupervisedArgusService(path.resolve('scripts/argus_runtime_bridge.py'));
  await argus.start();
  await argus.createOrResolveProject({ projectId: 'p', projectPath: dir, model: 'm' });
  await argus.resumeProject(dir);
  const features = new FeatureLoader();
  const planner = new ArgusOrchestrator(argus, features);
  const task = (await planner.reconcileProject(dir))!;
  Object.assign(task, {
    repository: 'o/r',
    baseBranch: 'main',
    prNumber: 7,
    prUrl: 'u',
    prHeadSha: 'a'.repeat(40),
    ciHeadSha: 'a'.repeat(40),
    ciState: 'success',
    reviewedHeadSha: 'a'.repeat(40),
    reviewVerdict: 'approve',
    phase: 'merge-ready',
    lease: null,
    blockedReason: null,
  });
  return { dir, argus, features, planner, task };
}
const pull = (overrides: Record<string, unknown> = {}) => ({
  number: 7,
  state: 'OPEN',
  url: 'u',
  repository: 'o/r',
  baseBranch: 'main',
  baseSha: '0'.repeat(40),
  headBranch: 'jules/x',
  headSha: 'a'.repeat(40),
  merged: false,
  mergeCommitSha: null,
  ...overrides,
});
function adapters(pr = pull()) {
  let current = pr;
  const github = {
    getPullRequest: vi.fn(async () => current),
    mergePullRequest: vi.fn(async () => {
      current = pull({ merged: true, state: 'CLOSED', mergeCommitSha: 'm'.repeat(40) });
      return { merged: true, sha: 'm'.repeat(40) };
    }),
  };
  const local = {
    inspect: vi.fn(async (_p, _b, merge) => ({
      currentBranch: 'main',
      localHead: 'r'.repeat(40),
      remoteHead: 'r'.repeat(40),
      remoteContainsMerge: Boolean(merge),
      dirty: false,
      localAhead: false,
    })),
    fetchAndInspect: vi.fn(async (_p, _b, merge) => ({
      currentBranch: 'main',
      localHead: 'r'.repeat(40),
      remoteHead: 'r'.repeat(40),
      remoteContainsMerge: Boolean(merge),
      dirty: false,
      localAhead: false,
    })),
    synchronize: vi.fn(async () => ({
      currentBranch: 'main',
      localHead: 'r'.repeat(40),
      remoteHead: 'r'.repeat(40),
      remoteContainsMerge: true,
      dirty: false,
      localAhead: false,
      recoveryRef: null,
      recoveryReason: null,
      recoveryOriginalHead: null,
      recoveryCreatedAt: null,
      recoverySnapshots: [],
    })),
  };
  return {
    github,
    local,
    git: new GitIntegrationService(github as any, local as any),
    getPr: () => current,
  };
}

describe('Milestone E merge and autonomous campaigns', () => {
  it('runs two exact-SHA cycles, renews once, then stops when objective is satisfied', async () => {
    const { dir, argus, features, planner, task } = await fixture();
    const a = adapters();
    vi.spyOn(argus, 'evaluateObjective')
      .mockResolvedValueOnce({
        satisfied: false,
        reasoning: 'gap remains',
        evidence: ['v1 done'],
        remainingGaps: [{ title: 'gap', description: 'next', evidence: [] }],
      })
      .mockResolvedValueOnce({
        satisfied: true,
        reasoning: 'complete',
        evidence: ['v2 done'],
        remainingGaps: [],
      });
    vi.spyOn(argus, 'renewSpecification').mockResolvedValue(
      '# Campaign two\n\n## Acceptance criteria\n- Finish gap\n'
    );
    const service = new MilestoneEOrchestrator(
      argus,
      features,
      a.git,
      new SpecRenewalService(),
      planner
    );
    await Promise.all([service.reconcile(dir), service.reconcile(dir)]);
    expect(a.github.mergePullRequest).toHaveBeenCalledOnce();
    const afterFirst = (await argus.getStatus(dir))!;
    expect(afterFirst.specRevision).toBe(2);
    expect(afterFirst.activeTask?.taskId).toBe('argus-task-r2');
    expect(await fs.readFile(path.join(dir, 'ARGUS.md'), 'utf8')).toContain('Stable objective');
    expect(
      (await fs.readdir(path.join(dir, '.automaker', 'spec-history'))).some((name) =>
        name.endsWith('.md')
      )
    ).toBe(true);

    const second = afterFirst.activeTask!;
    Object.assign(second, {
      repository: 'o/r',
      baseBranch: 'main',
      prNumber: 8,
      prHeadSha: 'b'.repeat(40),
      ciHeadSha: 'b'.repeat(40),
      ciState: 'success',
      reviewedHeadSha: 'b'.repeat(40),
      reviewVerdict: 'approve',
      phase: 'merge-ready',
      lease: null,
      blockedReason: null,
    });
    let secondPr = pull({ number: 8, headSha: 'b'.repeat(40), baseSha: 'r'.repeat(40) });
    a.github.getPullRequest.mockImplementation(async () => secondPr as any);
    a.github.mergePullRequest.mockImplementation(async () => {
      secondPr = pull({
        number: 8,
        headSha: 'b'.repeat(40),
        merged: true,
        state: 'CLOSED',
        mergeCommitSha: 'n'.repeat(40),
      });
      return { merged: true, sha: 'n'.repeat(40) };
    });
    await service.reconcile(dir);
    expect((await argus.getStatus(dir))?.autonomy).toBe('satisfied');
    expect((await argus.getStatus(dir))?.activeTask).toBeNull();
    expect((await argus.getStatus(dir))?.specRevision).toBe(2);
    await argus.stop();
  });

  it('recovers an unknown merge outcome without issuing another merge', async () => {
    const { dir, argus, features, task } = await fixture();
    task.phase = 'merge-intent';
    task.mergeIntent = {
      mergeAttemptId: 'x',
      prNumber: 7,
      expectedHeadSha: task.prHeadSha!,
      baseBranch: 'main',
      baseBeforeMergeSha: '0'.repeat(40),
      mergeOutcome: 'unknown',
      attemptedAt: new Date().toISOString(),
    };
    const a = adapters(pull({ merged: true, state: 'CLOSED', mergeCommitSha: 'm'.repeat(40) }));
    vi.spyOn(argus, 'evaluateObjective').mockResolvedValue({
      satisfied: true,
      reasoning: 'done',
      evidence: [],
      remainingGaps: [],
    });
    await new MilestoneEOrchestrator(argus, features, a.git).reconcile(dir);
    expect(a.github.mergePullRequest).not.toHaveBeenCalled();
    expect(task.events.some((event) => event.type === 'MERGE_RECOVERED_AFTER_RESTART')).toBe(true);
    await argus.stop();
  });

  it.each([
    ['head', { headSha: 'b'.repeat(40) }],
    ['base', { baseBranch: 'other' }],
    ['closed', { state: 'CLOSED' }],
  ])('blocks an invalid %s merge gate', async (_name, override) => {
    const { dir, argus, features, task } = await fixture();
    const a = adapters(pull(override));
    await new MilestoneEOrchestrator(argus, features, a.git).reconcile(dir);
    expect(a.github.mergePullRequest).not.toHaveBeenCalled();
    expect(task.phase === 'blocked' || task.phase === 'ci-check').toBe(true);
    await argus.stop();
  });
  it.each([
    ['merge conflicts with current base', 'MERGE_CONFLICT'],
    ['403 branch protection permission denied', 'MERGE_NOT_PERMITTED'],
    ['422 validation failed', 'MERGE_REJECTED'],
  ])('classifies definitive merge rejection: %s', async (message, code) => {
    const { task, argus } = await fixture();
    task.mergeIntent = {
      mergeAttemptId: 'attempt',
      prNumber: 7,
      expectedHeadSha: task.prHeadSha!,
      baseBranch: 'main',
      baseBeforeMergeSha: '0'.repeat(40),
      mergeOutcome: 'unknown',
      attemptedAt: new Date().toISOString(),
    };
    const github = { mergePullRequest: vi.fn().mockRejectedValue(new Error(message)) };
    await expect(
      new GitIntegrationService(github as any, {} as any).mergePullRequest(task)
    ).rejects.toThrow(code);
    await argus.stop();
  });
  it('keeps transport ambiguity distinct from permanent merge rejection', async () => {
    const { task, argus } = await fixture();
    task.mergeIntent = {
      mergeAttemptId: 'attempt',
      prNumber: 7,
      expectedHeadSha: task.prHeadSha!,
      baseBranch: 'main',
      baseBeforeMergeSha: '0'.repeat(40),
      mergeOutcome: 'unknown',
      attemptedAt: new Date().toISOString(),
    };
    const github = { mergePullRequest: vi.fn().mockRejectedValue(new Error('network timeout')) };
    await expect(
      new GitIntegrationService(github as any, {} as any).mergePullRequest(task)
    ).rejects.toThrow('MERGE_OUTCOME_UNKNOWN');
    await argus.stop();
  });
});

describe('DONE invariant', () => {
  const complete = () =>
    ({
      prHeadSha: 'h',
      reviewedHeadSha: 'h',
      ciHeadSha: 'h',
      ciState: 'success',
      mergeCommitSha: 'm',
      localSyncedSha: 'r',
      lease: null,
      blockedReason: null,
    }) as any;
  const repo = {
    currentBranch: 'main',
    localHead: 'r',
    remoteHead: 'r',
    remoteContainsMerge: true,
    dirty: false,
    localAhead: false,
  };
  const pr = pull({ merged: true, mergeCommitSha: 'm', headSha: 'h' });
  it('accepts only a fully synchronized exact-head task', () =>
    expect(assertDoneInvariant(complete(), repo, pr as any)).toBe(true));
  it.each([
    ['PR', (t: any, r: any, p: any) => (p.merged = false)],
    ['merge SHA', (t: any) => (t.mergeCommitSha = null)],
    ['merge identity', (_t: any, _r: any, p: any) => (p.mergeCommitSha = 'other')],
    ['remote containment', (_t: any, r: any) => (r.remoteContainsMerge = false)],
    ['local equality', (_t: any, r: any) => (r.localHead = 'x')],
    ['synced SHA', (t: any) => (t.localSyncedSha = 'x')],
    ['review SHA', (t: any) => (t.reviewedHeadSha = 'x')],
    ['CI SHA', (t: any) => (t.ciHeadSha = 'x')],
    ['lease', (t: any) => (t.lease = { executor: 'jules' })],
    ['blocked state', (t: any) => (t.blockedReason = 'x')],
  ])('rejects missing %s requirement', (_name, mutate) => {
    const task = complete(),
      state = { ...repo },
      remote = { ...pr };
    mutate(task, state, remote);
    expect(() => assertDoneInvariant(task, state, remote as any)).toThrow('DONE_INVARIANT_FAILED');
  });
});

describe('SpecRenewalService', () => {
  it('archives and atomically advances a campaign while rejecting no progress', async () => {
    const { dir, argus } = await fixture();
    const state = (await argus.getStatus(dir))!;
    const evaluation = {
      satisfied: false,
      reasoning: 'gap',
      evidence: ['x'],
      remainingGaps: [{ title: 'x', description: 'x', evidence: [] }],
    };
    const service = new SpecRenewalService();
    await service.renew(dir, state, '# New campaign', evaluation);
    expect(state.specRevision).toBe(2);
    expect(state.activeTask).toBeNull();
    await expect(service.renew(dir, state, '# New campaign', evaluation)).rejects.toThrow(
      'SPEC_RENEWAL_NO_PROGRESS'
    );
    await argus.stop();
  });
  it('reconciles an atomic spec write after a crash exactly once', async () => {
    const { dir, argus } = await fixture();
    await fs.writeFile(path.join(dir, 'spec.md'), '# externally completed renewal');
    const once = await resolveState('p', dir, 'm');
    const twice = await resolveState('p', dir, 'm');
    expect(once.specRevision).toBe(2);
    expect(twice.specRevision).toBe(2);
    expect(twice.activeTask).toBeNull();
    expect(twice.phase).toBe('planning');
    await argus.stop();
  });
  it('treats an external ARGUS.md edit as a human objective revision', async () => {
    const { dir, argus } = await fixture();
    const before = (await argus.getStatus(dir))!.objectiveHash;
    await fs.writeFile(path.join(dir, 'ARGUS.md'), '# Human changed objective');
    const state = await resolveState('p', dir, 'm');
    expect(state.objectiveHash).not.toBe(before);
    expect(state.activeTask).toBeNull();
    expect(state.autonomy).toBe('enabled');
    await argus.stop();
  });
  it('blocks after three consecutive renewal attempts without completed progress', async () => {
    const { dir, argus } = await fixture();
    const state = (await argus.getStatus(dir))!;
    state.consecutiveSpecRenewalsWithoutCompletedTask = 3;
    const evaluation = { satisfied: false, reasoning: 'same gap', evidence: [], remainingGaps: [] };
    await expect(
      new SpecRenewalService().renew(dir, state, '# Different campaign', evaluation)
    ).rejects.toThrow('SPEC_RENEWAL_LIMIT_REACHED');
    await argus.stop();
  });
});

describe('local Git reconciliation', () => {
  async function repositories() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-sync-'));
    dirs.push(root);
    const bare = path.join(root, 'remote.git'),
      seed = path.join(root, 'seed'),
      local = path.join(root, 'local');
    const run = async (cwd: string, ...args: string[]) => {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      return (await promisify(execFile)('git', args, { cwd })).stdout.trim();
    };
    await fs.mkdir(bare);
    await run(bare, 'init', '--bare');
    await fs.mkdir(seed);
    await run(seed, 'init', '-b', 'main');
    await run(seed, 'config', 'user.email', 't@e');
    await run(seed, 'config', 'user.name', 'T');
    await fs.writeFile(path.join(seed, 'f'), 'one');
    await run(seed, 'add', '.');
    await run(seed, 'commit', '-m', 'one');
    await run(seed, 'remote', 'add', 'origin', bare);
    await run(seed, 'push', '-u', 'origin', 'main');
    await run(root, 'clone', '-b', 'main', bare, local);
    await run(local, 'config', 'user.email', 't@e');
    await run(local, 'config', 'user.name', 'T');
    return {
      seed,
      local,
      run,
      advance: async (text: string) => {
        await fs.writeFile(path.join(seed, 'f'), text);
        await run(seed, 'commit', '-am', text);
        await run(seed, 'push');
        return run(seed, 'rev-parse', 'HEAD');
      },
    };
  }
  it('fast-forwards a clean checkout to authoritative origin', async () => {
    const r = await repositories(),
      merge = await r.advance('two');
    const result = await new CommandLocalGitAdapter().synchronize(r.local, 'main', merge, 't');
    expect(result.localHead).toBe(result.remoteHead);
    expect(result.recoveryRef).toBeNull();
  });
  it('stashes dirty and untracked work before synchronization', async () => {
    const r = await repositories(),
      merge = await r.advance('two');
    await fs.writeFile(path.join(r.local, 'dirty'), 'keep');
    const result = await new CommandLocalGitAdapter().synchronize(r.local, 'main', merge, 't');
    expect(result.recoveryRef).toMatch(/^refs\/automaker\/recovery\/.*-dirty-/);
    expect(result.recoveryReason).toBe('LOCAL_DIRTY_RECOVERY_CREATED');
    const snapshot = result.recoverySnapshots[0];
    expect(snapshot.kind).toBe('dirty-worktree');
    expect(await r.run(r.local, 'rev-parse', snapshot.ref)).toBe(snapshot.objectSha);
    await fs.writeFile(path.join(r.local, 'later'), 'another recovery');
    await r.run(r.local, 'stash', 'push', '-u', '-m', 'later stash');
    expect(await r.run(r.local, 'rev-parse', snapshot.ref)).toBe(snapshot.objectSha);
  });
  it('creates a durable recovery ref before aligning divergent commits', async () => {
    const r = await repositories();
    await fs.writeFile(path.join(r.local, 'local'), 'unique');
    await r.run(r.local, 'add', '.');
    await r.run(r.local, 'commit', '-m', 'local');
    const original = await r.run(r.local, 'rev-parse', 'HEAD'),
      merge = await r.advance('remote');
    const result = await new CommandLocalGitAdapter().synchronize(r.local, 'main', merge, 't');
    expect(result.recoveryRef).toContain('refs/automaker/recovery/');
    expect(result.recoverySnapshots).toEqual([
      expect.objectContaining({ kind: 'local-divergence', objectSha: original }),
    ]);
    expect(await r.run(r.local, 'cat-file', '-t', original)).toBe('commit');
    expect(result.localHead).toBe(result.remoteHead);
  });
  it('retains separate immutable snapshots for dirty and divergent local state', async () => {
    const r = await repositories();
    await fs.writeFile(path.join(r.local, 'local'), 'unique');
    await r.run(r.local, 'add', '.');
    await r.run(r.local, 'commit', '-m', 'local');
    await fs.writeFile(path.join(r.local, 'dirty'), 'uncommitted');
    const merge = await r.advance('remote');
    const result = await new CommandLocalGitAdapter().synchronize(r.local, 'main', merge, 't');
    expect(result.recoverySnapshots.map((snapshot) => snapshot.kind)).toEqual([
      'dirty-worktree',
      'local-divergence',
    ]);
    for (const snapshot of result.recoverySnapshots)
      expect(await r.run(r.local, 'rev-parse', snapshot.ref)).toBe(snapshot.objectSha);
  });
  it('fetches before inspecting authoritative state so a stale origin ref cannot certify DONE', async () => {
    const r = await repositories();
    const before = await r.run(r.local, 'rev-parse', 'origin/main');
    const advanced = await r.advance('remote advanced');
    expect(before).not.toBe(advanced);
    expect(await r.run(r.local, 'rev-parse', 'origin/main')).toBe(before);
    const state = await new CommandLocalGitAdapter().fetchAndInspect(r.local, 'main');
    expect(state.remoteHead).toBe(advanced);
    expect(state.localHead).toBe(before);
  });
});

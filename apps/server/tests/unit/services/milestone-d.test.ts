import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { FeatureLoader } from '../../../src/services/feature-loader.js';
import {
  ArgusOrchestrator,
  GitHubCiObserver,
  GitSeniorWorktreeAdapter,
  JulesClient,
  MilestoneDOrchestrator,
  OpenCodeRoleRunner,
  SupervisedArgusService,
  ensureArgusControlFiles,
} from '../../../src/services/argus/index.js';

const dirs: string[] = [];
afterEach(async () => {
  delete process.env.ARGUS_BRIDGE_FAKE;
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'milestone-d-'));
  dirs.push(dir);
  await ensureArgusControlFiles(dir, '# spec', '# objective');
  process.env.ARGUS_BRIDGE_FAKE = '1';
  const argus = new SupervisedArgusService(path.resolve('scripts/argus_runtime_bridge.py'));
  await argus.start();
  await argus.createOrResolveProject({ projectId: 'p', projectPath: dir, model: 'm' });
  await argus.resumeProject(dir);
  const features = new FeatureLoader();
  const task = (await new ArgusOrchestrator(argus, features).reconcileProject(dir))!;
  Object.assign(task, {
    repository: 'o/r',
    baseBranch: 'main',
    prNumber: 7,
    prUrl: 'https://github.com/o/r/pull/7',
    prHeadSha: 'a'.repeat(40),
    phase: 'pr-open',
    julesSessionId: 'j1',
    julesState: 'IN_PROGRESS',
  });
  return { dir, argus, features, task };
}
const pr = (sha = 'a'.repeat(40)) => ({
  number: 7,
  state: 'OPEN',
  url: 'u',
  repository: 'o/r',
  baseBranch: 'main',
  headBranch: 'jules/x',
  headSha: sha,
});
const ci = (state: any, sha = 'a'.repeat(40)) => ({
  headSha: sha,
  state,
  observedAt: new Date().toISOString(),
  runIds: ['1'],
  failures:
    state === 'failure'
      ? [
          {
            workflowName: 'CI',
            workflowRunId: '1',
            jobName: 'test',
            jobId: '2',
            failedStep: 'unit',
            conclusion: 'failure',
            excerpt: 'failed',
            observedAt: new Date().toISOString(),
          },
        ]
      : [],
});

describe('Milestone D orchestration', () => {
  it('ties success and fresh structured approval to the exact PR head', async () => {
    const { dir, argus, features, task } = await fixture();
    const github = {
      getPullRequest: vi.fn().mockResolvedValue(pr()),
      getPullRequestDiff: vi.fn().mockResolvedValue('diff'),
      observe: vi.fn().mockResolvedValue(ci('success')),
    };
    const senior = {
      review: vi.fn().mockResolvedValue({
        contextId: 'review-1',
        result: {
          verdict: 'approve',
          reviewedHeadSha: task.prHeadSha,
          findings: [],
          requiredChanges: [],
          evidence: ['green'],
        },
      }),
      diagnose: vi.fn(),
      execute: vi.fn(),
    };
    const service = new MilestoneDOrchestrator(
      argus,
      features,
      github as any,
      {} as JulesClient,
      senior as any
    );
    await service.reconcile(dir);
    expect(task).toMatchObject({
      phase: 'merge-ready',
      ciHeadSha: task.prHeadSha,
      ciState: 'success',
      reviewedHeadSha: task.prHeadSha,
      reviewVerdict: 'approve',
    });
    expect(task.events.map((event) => event.type)).toContain('MERGE_READY');
    await argus.stop();
  });

  it('invalidates stale CI/review evidence when the PR head changes', async () => {
    const { dir, argus, features, task } = await fixture();
    task.ciHeadSha = task.prHeadSha;
    task.ciState = 'success';
    task.reviewedHeadSha = task.prHeadSha;
    task.reviewVerdict = 'approve';
    const next = 'b'.repeat(40);
    const github = {
      getPullRequest: vi.fn().mockResolvedValue(pr(next)),
      observe: vi.fn().mockResolvedValue(ci('pending', next)),
    };
    await new MilestoneDOrchestrator(
      argus,
      features,
      github as any,
      {} as JulesClient,
      {} as any
    ).reconcile(dir);
    expect(task).toMatchObject({
      prHeadSha: next,
      ciHeadSha: next,
      ciState: 'pending',
      reviewedHeadSha: null,
      reviewVerdict: null,
    });
    expect(task.events.some((event) => event.type === 'PR_HEAD_CHANGED')).toBe(true);
    await argus.stop();
  });

  it('rejects an approval when GitHub changes head during review', async () => {
    const { dir, argus, features, task } = await fixture();
    const next = 'c'.repeat(40);
    const github = {
      getPullRequest: vi.fn().mockResolvedValueOnce(pr()).mockResolvedValueOnce(pr(next)),
      getPullRequestDiff: vi.fn().mockResolvedValue('diff'),
      observe: vi.fn().mockResolvedValue(ci('success')),
    };
    const senior = {
      review: vi.fn().mockResolvedValue({
        contextId: 'review-old',
        result: {
          verdict: 'approve',
          reviewedHeadSha: task.prHeadSha,
          findings: [],
          requiredChanges: [],
          evidence: [],
        },
      }),
    };
    await new MilestoneDOrchestrator(
      argus,
      features,
      github as any,
      {} as any,
      senior as any
    ).reconcile(dir);
    expect(task).toMatchObject({
      phase: 'ci-check',
      prHeadSha: next,
      ciHeadSha: null,
      reviewedHeadSha: null,
      reviewVerdict: null,
      lastArgusEvent: 'REVIEW_STALE',
    });
    await argus.stop();
  });

  it('fails closed when CI is required but no checks are configured', async () => {
    const { dir, argus, features, task } = await fixture();
    const github = {
      getPullRequest: vi.fn().mockResolvedValue(pr()),
      observe: vi.fn().mockResolvedValue(ci('not-configured')),
    };
    await new MilestoneDOrchestrator(
      argus,
      features,
      github as any,
      {} as JulesClient,
      {} as any
    ).reconcile(dir);
    expect(task).toMatchObject({
      phase: 'blocked',
      blockedReason: 'CI_REQUIRED_BUT_NOT_CONFIGURED',
    });
    await argus.stop();
  });

  it('dispatches exactly one durable active-session repair under concurrent reconciliation', async () => {
    const { dir, argus, features, task } = await fixture();
    const github = {
      getPullRequest: vi.fn().mockResolvedValue(pr()),
      getPullRequestDiff: vi.fn().mockResolvedValue('diff'),
      observe: vi.fn().mockResolvedValue(ci('failure')),
    };
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const service = new MilestoneDOrchestrator(
      argus,
      features,
      github as any,
      { sendMessage } as any,
      {} as any
    );
    await Promise.all([service.reconcile(dir), service.reconcile(dir)]);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(task).toMatchObject({
      phase: 'jules-repair',
      julesRepairAttempt: 1,
      repairAgainstHeadSha: task.prHeadSha,
    });
    await argus.stop();
  });

  it('fails closed to Senior diagnosis for a terminal Jules session', async () => {
    const { dir, argus, features, task } = await fixture();
    task.julesState = 'COMPLETED';
    const github = {
      getPullRequest: vi.fn().mockResolvedValue(pr()),
      getPullRequestDiff: vi.fn().mockResolvedValue('diff'),
      observe: vi.fn().mockResolvedValue(ci('failure')),
    };
    const senior = {
      diagnose: vi.fn().mockResolvedValue({
        contextId: 'd',
        result: {
          rootCause: 'test',
          recommendedFix: 'fix',
          juniorCanRepair: false,
          evidence: ['ci'],
          filesLikelyAffected: ['x.ts'],
        },
      }),
      review: vi.fn(),
      execute: vi.fn(),
    };
    await new MilestoneDOrchestrator(
      argus,
      features,
      github as any,
      {} as any,
      senior as any
    ).reconcile(dir);
    expect(task.phase).toBe('senior-takeover');
    expect(task.events.map((event) => event.type)).toContain('JULES_TERMINAL_REPAIR_UNSAFE');
    expect(task.lease?.executor).toBe('senior');
    await argus.stop();
  });
});

describe('GitHubCiObserver', () => {
  it('bounds and redacts exact-head failure evidence', async () => {
    const runner = vi.fn(async (args: string[]) => {
      const route = args[1];
      if (route.includes('check-runs'))
        return JSON.stringify({
          check_runs: [{ head_sha: 'a', status: 'completed', conclusion: 'failure' }],
        });
      if (route.includes('actions/runs?'))
        return JSON.stringify({
          workflow_runs: [
            { id: 1, name: 'CI', head_sha: 'a', status: 'completed', conclusion: 'failure' },
          ],
        });
      if (route.includes('/jobs?'))
        return JSON.stringify({
          jobs: [
            {
              id: 2,
              name: 'test',
              conclusion: 'failure',
              steps: [{ name: 'unit', conclusion: 'failure' }],
            },
          ],
        });
      return `${'x'.repeat(2500)}SECRET`;
    });
    const result = await new GitHubCiObserver(runner, ['SECRET']).observe('o/r', 'a');
    expect(result.state).toBe('failure');
    expect(result.failures[0].excerpt.length).toBeLessThanOrEqual(2000);
    expect(result.failures[0].excerpt).not.toContain('SECRET');
  });

  it('distinguishes zero checks from pending checks and ignores wrong heads', async () => {
    const empty = new GitHubCiObserver(async () => JSON.stringify({}));
    await expect(empty.observe('o/r', 'a')).resolves.toMatchObject({ state: 'not-configured' });
    const pending = new GitHubCiObserver(async (args) =>
      args[1].includes('check-runs')
        ? JSON.stringify({
            check_runs: [
              { head_sha: 'wrong', status: 'completed', conclusion: 'success' },
              { head_sha: 'a', status: 'in_progress', conclusion: null },
            ],
          })
        : JSON.stringify({ workflow_runs: [] })
    );
    await expect(pending.observe('o/r', 'a')).resolves.toMatchObject({ state: 'pending' });
  });
});

describe('OpenCodeRoleRunner', () => {
  it('uses fresh isolated read-only contexts and rejects malformed output', async () => {
    const calls: any[] = [];
    const runner = new OpenCodeRoleRunner('automaker-compatible/model', async (input) => {
      calls.push(input);
      return input.role === 'diagnostic'
        ? JSON.stringify({
            rootCause: 'x',
            recommendedFix: 'y',
            juniorCanRepair: false,
            evidence: [],
            filesLikelyAffected: [],
          })
        : JSON.stringify({
            verdict: 'approve',
            reviewedHeadSha: 'a',
            findings: [],
            requiredChanges: [],
            evidence: [],
          });
    });
    await runner.diagnose({});
    await runner.review({});
    expect(calls.map((call) => call.model)).toEqual([
      'automaker-compatible/model',
      'automaker-compatible/model',
    ]);
    expect(calls.every((call) => call.readOnly && !call.cwd.includes(process.cwd()))).toBe(true);
    expect(calls[0].contextId).not.toBe(calls[1].contextId);
    await expect(
      new OpenCodeRoleRunner('automaker-compatible/model', async () => 'not json').review({})
    ).rejects.toThrow('OPENCODE_MALFORMED_OUTPUT');
  });
});

describe('Senior worktree isolation', () => {
  it('commits a patch in an isolated deterministic branch without changing the base checkout', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'senior-worktree-'));
    dirs.push(repo);
    const git = async (...args: string[]) => {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      return promisify(execFile)('git', args, { cwd: repo });
    };
    await git('init', '-b', 'main');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test');
    await fs.writeFile(path.join(repo, 'ARGUS.md'), '# immutable');
    await fs.writeFile(path.join(repo, 'file.txt'), 'base');
    await git('add', '.');
    await git('commit', '-m', 'base');
    const base = (await git('rev-parse', 'HEAD')).stdout.trim();
    const adapter = new GitSeniorWorktreeAdapter();
    const worktree = await adapter.prepare(repo, 'automaker/senior/task-1', base);
    dirs.unshift(path.join(path.dirname(repo), '.automaker-worktrees'));
    await fs.writeFile(path.join(worktree, 'file.txt'), 'patched');
    const commit = await adapter.commit(worktree, 'fix: senior patch');
    expect(commit).not.toBe(base);
    expect(await fs.readFile(path.join(repo, 'file.txt'), 'utf8')).toBe('base');
    expect((await git('rev-parse', 'HEAD')).stdout.trim()).toBe(base);
    await fs.writeFile(path.join(worktree, 'ARGUS.md'), '# mutated');
    await expect(adapter.commit(worktree, 'bad')).rejects.toThrow(
      'SENIOR_ARGUS_CHARTER_MUTATION_FORBIDDEN'
    );
  });
});

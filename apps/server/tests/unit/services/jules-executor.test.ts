import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { FeatureLoader } from '../../../src/services/feature-loader.js';
import {
  ArgusOrchestrator,
  JulesClient,
  JulesDeveloperAdapter,
  JulesError,
  SupervisedArgusService,
  ensureArgusControlFiles,
  normalizeGitHubRepository,
} from '../../../src/services/argus/index.js';

const dirs: string[] = [];
const response = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status });
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jules-test-'));
  dirs.push(dir);
  await ensureArgusControlFiles(dir, '# spec', '# objective');
  process.env.ARGUS_BRIDGE_FAKE = '1';
  const argus = new SupervisedArgusService(
    path.resolve(process.cwd(), 'scripts/argus_runtime_bridge.py')
  );
  await argus.start();
  await argus.createOrResolveProject({ projectId: 'p', projectPath: dir, model: 'm' });
  await argus.resumeProject(dir);
  const features = new FeatureLoader();
  const task = await new ArgusOrchestrator(argus, features).reconcileProject(dir);
  return { dir, argus, features, task: task! };
}
afterEach(async () => {
  delete process.env.ARGUS_BRIDGE_FAKE;
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('JulesDeveloperAdapter', () => {
  it.each([
    ['git@github.com:Owner/Repo.git'],
    ['https://github.com/Owner/Repo.git'],
    ['https://github.com/Owner/Repo'],
  ])('normalizes GitHub remote %s', (remote) =>
    expect(normalizeGitHubRepository(remote)).toBe('owner/repo')
  );
  it('uses only its explicit API key and refuses missing auth', async () => {
    const fetcher = vi.fn();
    await expect(new JulesClient(undefined, fetcher).listSources()).rejects.toMatchObject({
      code: 'JULES_AUTH_FAILED',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('matches one exact source and refuses missing or ambiguous registrations', async () => {
    const sources = [
      { name: 'sources/a', githubRepo: { owner: 'o', repo: 'r' } },
      { name: 'sources/b', githubRepo: { owner: 'o', repo: 'r' } },
    ];
    const client = new JulesClient(
      'jules-only',
      vi.fn().mockImplementation(async () => response({ sources }))
    );
    await expect(client.findRepositorySource('o/r')).rejects.toMatchObject({
      code: 'JULES_SOURCE_NOT_FOUND',
      blocked: true,
    });
    await expect(client.findRepositorySource('missing/repo')).rejects.toMatchObject({
      code: 'JULES_SOURCE_NOT_FOUND',
    });
  });
  it('creates AUTO_CREATE_PR with auto-approved plan and supports activities, messages and cancellation', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({ id: 's1', name: 'sessions/s1', state: 'QUEUED' }))
      .mockResolvedValueOnce(response({ activities: [{ type: 'PLAN' }] }))
      .mockResolvedValueOnce(response({}, 204))
      .mockResolvedValueOnce(response({}, 204));
    const client = new JulesClient('secret', fetcher);
    await client.createTaskSession({
      prompt: 'p',
      title: 't',
      source: 'sources/x',
      branch: 'main',
    });
    const request = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(request).toMatchObject({ requirePlanApproval: false, automationMode: 'AUTO_CREATE_PR' });
    expect((await client.listActivities('s1'))[0].type).toBe('PLAN');
    await client.sendMessage('s1', 'fix');
    await client.cancelSession('s1');
    expect(fetcher.mock.calls[2][0]).toContain(':sendMessage');
    expect(fetcher.mock.calls[3][1].method).toBe('DELETE');
  });
  it('persists a session before monitoring and never creates a duplicate session on restart', async () => {
    const { dir, argus, features, task } = await fixture();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response({ sources: [{ name: 'sources/repo', githubRepo: { owner: 'o', repo: 'r' } }] })
      )
      .mockResolvedValueOnce(
        response({ id: 'session-1', name: 'sessions/session-1', state: 'QUEUED' })
      );
    const adapter = new JulesDeveloperAdapter(new JulesClient('j', fetcher), argus, features, {
      autoMonitor: false,
      captureGit: async () => ({
        repository: 'o/r',
        baseBranch: 'main',
        baseRemoteSha: 'a'.repeat(40),
      }),
    });
    await adapter.dispatch(task, dir);
    expect((await argus.getStatus(dir))?.activeTask?.julesSessionId).toBe('session-1');
    expect((await features.get(dir, task.featureId))?.argus).toMatchObject({
      julesSessionId: 'session-1',
      baseRemoteSha: 'a'.repeat(40),
    });
    const getSession = vi.spyOn(adapter, 'reconcile').mockResolvedValue();
    await adapter.dispatch(task, dir);
    expect(getSession).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
    await argus.stop();
  });
  it('recovers a completed session, verifies the PR independently, and stops at PR_OPEN', async () => {
    const { dir, argus, features, task } = await fixture();
    task.julesSessionId = 's1';
    const session = {
      id: 's1',
      name: 'sessions/s1',
      state: 'COMPLETED',
      outputs: [{ pullRequest: { url: 'https://github.com/o/r/pull/7' } }],
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(session))
      .mockResolvedValueOnce(
        response({ activities: [{ type: 'PULL_REQUEST', description: 'Pull request created' }] })
      );
    const adapter = new JulesDeveloperAdapter(new JulesClient('j', fetcher), argus, features, {
      autoMonitor: false,
      verifyPr: async () => ({
        number: 7,
        url: 'https://github.com/o/r/pull/7',
        headSha: 'b'.repeat(40),
        branch: 'jules/work',
      }),
    });
    await adapter.reconcile(task, dir);
    expect(task).toMatchObject({
      phase: 'pr-open',
      prNumber: 7,
      prHeadSha: 'b'.repeat(40),
      mergedSha: null,
      localSyncedSha: null,
    });
    await argus.stop();
  });
  it('normalizes remote failure without silently replacing a session', async () => {
    const client = new JulesClient('j', vi.fn().mockResolvedValue(response({}, 503)));
    await expect(client.getSession('s')).rejects.toEqual(
      expect.objectContaining<JulesError>({ code: 'JULES_REMOTE_FAILED', retryable: true })
    );
  });
});

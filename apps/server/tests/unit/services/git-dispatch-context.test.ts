import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureGitDispatchContext,
  verifyPullRequest,
} from '../../../src/services/argus/git-context.js';

const mocks = vi.hoisted(() => ({ git: vi.fn(), spawn: vi.fn() }));
vi.mock('@automaker/git-utils', () => ({ execGitCommand: mocks.git }));
vi.mock('@automaker/platform', () => ({ spawnProcess: mocks.spawn }));

const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const project = '/registered/project';
const expected = { repository: 'owner/repository', baseBranch: 'main', branch: 'jules/task' };
const pr = {
  number: 11,
  url: 'https://github.com/owner/repository/pull/11',
  state: 'OPEN',
  baseRefName: 'main',
  headRefName: 'jules/task',
  headRefOid: headSha,
  headRepositoryOwner: { login: 'Owner' },
  headRepository: { name: 'Repository' },
};

beforeEach(() => {
  mocks.git.mockImplementation(async (args: string[]) => {
    if (args[0] === 'remote') return 'git@github.com:owner/repository.git\n';
    if (args[0] === 'symbolic-ref') return 'origin/main\n';
    if (args[0] === 'rev-parse') return baseSha + '\n';
    return '';
  });
  mocks.spawn.mockResolvedValue({ exitCode: 0, stdout: 'main\n', stderr: '' });
});

describe('canonical GitHub dispatch context', () => {
  it('fetches canonical remote state and honors an explicit integration branch without a CLI lookup', async () => {
    await expect(captureGitDispatchContext(project, 'release')).resolves.toEqual({
      repository: 'owner/repository',
      baseBranch: 'release',
      baseRemoteSha: baseSha,
    });
    expect(mocks.git.mock.calls.map(([args]) => args)).toEqual([
      ['remote', 'get-url', 'origin'],
      ['fetch', '--prune', 'origin'],
      ['rev-parse', 'origin/release'],
    ]);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('uses GitHub default branch evidence when no explicit integration branch is configured', async () => {
    await expect(captureGitDispatchContext(project)).resolves.toMatchObject({
      baseBranch: 'main',
      baseRemoteSha: baseSha,
    });
    expect(mocks.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'gh',
        args: [
          'repo',
          'view',
          'owner/repository',
          '--json',
          'defaultBranchRef',
          '--jq',
          '.defaultBranchRef.name',
        ],
        cwd: project,
      })
    );
  });

  it.each(['nonzero', 'exception', 'empty'])(
    'falls back to origin/HEAD after a %s GitHub lookup',
    async (kind) => {
      if (kind === 'exception') mocks.spawn.mockRejectedValue(new Error('unavailable'));
      else
        mocks.spawn.mockResolvedValue({
          exitCode: kind === 'nonzero' ? 1 : 0,
          stdout: '',
          stderr: '',
        });
      await expect(captureGitDispatchContext(project)).resolves.toMatchObject({
        baseBranch: 'main',
      });
      expect(mocks.git).toHaveBeenCalledWith(
        ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
        project
      );
    }
  );

  it('fails closed when neither authoritative default branch lookup succeeds', async () => {
    mocks.spawn.mockRejectedValue(new Error('unavailable'));
    mocks.git.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote') return 'https://github.com/owner/repository';
      if (args[0] === 'symbolic-ref') throw new Error('missing origin/HEAD');
      return '';
    });
    await expect(captureGitDispatchContext(project)).rejects.toThrow(
      'could not determine integration branch'
    );
    expect(mocks.git.mock.calls.some(([args]) => args[0] === 'rev-parse')).toBe(false);
  });

  it.each(['missing', 'non-GitHub'])(
    'rejects a %s origin before fetch or dispatch',
    async (kind) => {
      if (kind === 'missing') mocks.git.mockRejectedValue(new Error('no origin'));
      else mocks.git.mockResolvedValue('https://other.example/owner/repository.git');
      await expect(captureGitDispatchContext(project)).rejects.toThrow(
        'GITHUB_REMOTE_REQUIRED_FOR_JULES'
      );
      expect(mocks.git).toHaveBeenCalledTimes(1);
      expect(mocks.spawn).not.toHaveBeenCalled();
    }
  );

  it('propagates a fetch failure instead of using stale local remote state', async () => {
    mocks.git.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote') return 'https://github.com/owner/repository.git';
      throw new Error('fetch denied');
    });
    await expect(captureGitDispatchContext(project, 'main')).rejects.toThrow('fetch denied');
    expect(mocks.git.mock.calls.some(([args]) => args[0] === 'rev-parse')).toBe(false);
  });
});

describe('Jules PR identity', () => {
  it('returns exact head and branch only after checking repository, branch and open state', async () => {
    mocks.spawn.mockResolvedValue({ exitCode: 0, stdout: JSON.stringify(pr), stderr: '' });
    await expect(verifyPullRequest(pr.url, project, expected)).resolves.toEqual({
      number: 11,
      url: pr.url,
      headSha,
      branch: 'jules/task',
    });
    await expect(
      verifyPullRequest(pr.url, project, { repository: 'OWNER/REPOSITORY', baseBranch: 'main' })
    ).resolves.toMatchObject({ headSha });
  });

  it.each([
    { state: 'CLOSED' },
    { baseRefName: 'unexpected' },
    { headRefName: 'another-task' },
    { headRepositoryOwner: { login: 'fork-owner' } },
    { headRepository: { name: 'another-repository' } },
  ])('rejects mismatched PR evidence %j', async (change) => {
    mocks.spawn.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ ...pr, ...change }),
      stderr: '',
    });
    await expect(verifyPullRequest(pr.url, project, expected)).rejects.toThrow(
      'PR identity mismatch'
    );
  });

  it('rejects unavailable and malformed PR evidence', async () => {
    mocks.spawn
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'unavailable' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{', stderr: '' });
    await expect(verifyPullRequest(pr.url, project, expected)).rejects.toThrow(
      'GITHUB_PR_LOOKUP_FAILED'
    );
    await expect(verifyPullRequest(pr.url, project, expected)).rejects.toThrow();
  });
});

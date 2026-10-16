import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  stageFiles,
  StageFilesValidationError,
} from '../../../src/services/stage-files-service.js';
import {
  hasAnyChanges,
  localBranchExists,
  popStash,
  stashChanges,
} from '../../../src/services/branch-utils.js';
import { performCheckoutBranch } from '../../../src/services/checkout-branch-service.js';
import {
  applyOrPop,
  dropStash,
  getConflictedFiles,
  listStash,
  pushStash,
} from '../../../src/services/stash-service.js';
import { getCommitLog } from '../../../src/services/commit-log-service.js';
import { getBranchCommitLog } from '../../../src/services/branch-commit-log-service.js';

const execFileAsync = promisify(execFile);
let repository: string;
async function git(...args: string[]) {
  return (
    await execFileAsync('git', args, {
      cwd: repository,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    })
  ).stdout.trim();
}
async function commit(file: string, content: string, message: string) {
  await fs.writeFile(path.join(repository, file), content);
  await git('add', '--', file);
  await git('commit', '-m', message);
  return git('rev-parse', 'HEAD');
}

beforeEach(async () => {
  repository = await fs.mkdtemp(path.join(os.tmpdir(), 'git-workflow-contract-'));
  await git('init', '--initial-branch=main');
  await git('config', 'user.name', 'Workflow Test');
  await git('config', 'user.email', 'workflow@example.invalid');
  await commit('tracked.txt', 'baseline\n', 'Initial commit');
});
afterEach(async () => fs.rm(repository, { recursive: true, force: true }));

describe('real repository staging boundaries', () => {
  it('stages literal filenames and unstages without deleting user contents', async () => {
    const filename = '--literal;$(unused).txt';
    await fs.writeFile(path.join(repository, filename), 'user content');
    await expect(stageFiles(repository, [filename], 'stage')).resolves.toEqual({
      operation: 'stage',
      filesCount: 1,
    });
    expect(await git('diff', '--cached', '--name-only')).toBe(filename);
    await expect(stageFiles(repository, [filename], 'unstage')).resolves.toEqual({
      operation: 'unstage',
      filesCount: 1,
    });
    expect(await git('diff', '--cached', '--name-only')).toBe('');
    expect(await fs.readFile(path.join(repository, filename), 'utf8')).toBe('user content');
  });

  it.each(['', '  ', '../outside.txt', '/tmp/outside.txt'])(
    'rejects invalid path %j without staging other supplied paths',
    async (invalid) => {
      await fs.writeFile(path.join(repository, 'safe.txt'), 'safe');
      await expect(stageFiles(repository, ['safe.txt', invalid], 'stage')).rejects.toBeInstanceOf(
        StageFilesValidationError
      );
      expect(await git('diff', '--cached', '--name-only')).toBe('');
    }
  );

  it('fails clearly for a missing worktree and accepts a canonicalized worktree alias', async () => {
    await expect(
      stageFiles(path.join(repository, 'missing'), ['tracked.txt'], 'stage')
    ).rejects.toThrow('worktreePath does not exist');
    const alias = repository + '-alias';
    await fs.symlink(repository, alias, 'dir');
    try {
      await fs.writeFile(path.join(repository, 'tracked.txt'), 'changed\n');
      await stageFiles(alias, ['tracked.txt'], 'stage');
      expect(await git('diff', '--cached', '--name-only')).toBe('tracked.txt');
    } finally {
      await fs.unlink(alias);
    }
  });
});

describe('real branch and stash recovery', () => {
  it('detects tracked and optional untracked changes while ignoring internal worktree entries only when requested', async () => {
    expect(await hasAnyChanges(repository)).toBe(false);
    await fs.mkdir(path.join(repository, '.worktrees'));
    await fs.writeFile(path.join(repository, '.worktrees', 'untracked'), 'internal');
    expect(await hasAnyChanges(repository)).toBe(true);
    expect(await hasAnyChanges(repository, { excludeWorktreePaths: true })).toBe(false);
    expect(await hasAnyChanges(repository, { includeUntracked: false })).toBe(false);
    await fs.writeFile(path.join(repository, 'tracked.txt'), 'changed\n');
    expect(
      await hasAnyChanges(repository, { includeUntracked: false, excludeWorktreePaths: true })
    ).toBe(true);
    expect(await hasAnyChanges(path.join(repository, 'missing'))).toBe(false);
  });

  it('creates a branch and restores both tracked and untracked edits exactly once', async () => {
    await fs.writeFile(path.join(repository, 'tracked.txt'), 'uncommitted edit\n');
    await fs.writeFile(path.join(repository, 'new.txt'), 'untracked edit\n');
    const events = { emit: vi.fn() };
    const result = await performCheckoutBranch(
      repository,
      'task/next',
      'main',
      { stashChanges: true },
      events as never
    );
    expect(result).toMatchObject({
      success: true,
      result: {
        previousBranch: 'main',
        newBranch: 'task/next',
        stashedChanges: true,
        hasConflicts: false,
      },
    });
    expect(await git('branch', '--show-current')).toBe('task/next');
    expect(await fs.readFile(path.join(repository, 'tracked.txt'), 'utf8')).toBe(
      'uncommitted edit\n'
    );
    expect(await fs.readFile(path.join(repository, 'new.txt'), 'utf8')).toBe('untracked edit\n');
    expect(await git('stash', 'list')).toBe('');
    expect(events.emit.mock.calls.filter(([name]) => name === 'switch:pop')).toHaveLength(1);
  });

  it('preserves edits when branch creation fails and rejects existing or missing base branches', async () => {
    await fs.writeFile(path.join(repository, 'tracked.txt'), 'preserve me\n');
    await expect(
      performCheckoutBranch(repository, 'bad..branch', undefined, { stashChanges: true })
    ).resolves.toMatchObject({ success: false });
    expect(await git('branch', '--show-current')).toBe('main');
    expect(await fs.readFile(path.join(repository, 'tracked.txt'), 'utf8')).toBe('preserve me\n');
    expect(await git('stash', 'list')).toBe('');
    await expect(performCheckoutBranch(repository, 'main')).resolves.toMatchObject({
      success: false,
      error: "Branch 'main' already exists",
    });
    await expect(performCheckoutBranch(repository, 'new-branch', 'missing')).resolves.toMatchObject(
      { success: false, error: "Base branch 'missing' does not exist" }
    );
    expect(await localBranchExists(repository, 'main')).toBe(true);
    expect(await localBranchExists(repository, 'missing')).toBe(false);
  });

  it('keeps a conflicting stash available for recovery and reports the conflict files', async () => {
    await fs.writeFile(path.join(repository, 'tracked.txt'), 'stashed side\n');
    expect(await stashChanges(repository, 'recovery fixture')).toBe(true);
    await commit('tracked.txt', 'committed side\n', 'Competing change');
    await expect(popStash(repository)).resolves.toMatchObject({
      success: false,
      hasConflicts: true,
    });
    expect(await getConflictedFiles(repository)).toEqual(['tracked.txt']);
    expect(await git('stash', 'list')).toContain('recovery fixture');
  });

  it('round-trips stash metadata and distinguishes apply from pop and drop', async () => {
    await expect(pushStash(repository)).resolves.toMatchObject({ success: true, stashed: false });
    await expect(listStash(repository)).resolves.toMatchObject({ total: 0, stashes: [] });
    await fs.writeFile(path.join(repository, 'tracked.txt'), 'saved edit\n');
    await expect(
      pushStash(repository, { message: '  user recovery  ', files: ['tracked.txt'] })
    ).resolves.toMatchObject({
      success: true,
      stashed: true,
      branch: 'main',
      message: 'user recovery',
    });
    const listed = await listStash(repository);
    expect(listed.total).toBe(1);
    expect(listed.stashes[0]).toMatchObject({ index: 0, branch: 'main', files: ['tracked.txt'] });
    expect(Number.isFinite(Date.parse(listed.stashes[0].date))).toBe(true);
    await expect(applyOrPop(repository, 0, {})).resolves.toMatchObject({
      success: true,
      applied: true,
      operation: 'apply',
    });
    expect(await fs.readFile(path.join(repository, 'tracked.txt'), 'utf8')).toBe('saved edit\n');
    expect((await listStash(repository)).total).toBe(1);
    await git('restore', '--', 'tracked.txt');
    await expect(applyOrPop(repository, 0, { pop: true })).resolves.toMatchObject({
      success: true,
      applied: true,
      operation: 'pop',
    });
    expect((await listStash(repository)).total).toBe(0);
    await pushStash(repository);
    await expect(dropStash(repository, 0)).resolves.toMatchObject({
      success: true,
      dropped: true,
      stashIndex: 0,
    });
    expect((await listStash(repository)).total).toBe(0);
    await expect(applyOrPop(repository, 5)).resolves.toMatchObject({ success: false });
  });
});

describe('real commit log parsing', () => {
  it('preserves multiline messages, filenames and branch identity with a bounded result', async () => {
    const latest = await commit(
      'space name.txt',
      'content',
      'Summary\n\nBody with ---END--- marker\nand another line'
    );
    const log = await getCommitLog(repository, 1);
    expect(log.branch).toBe('main');
    expect(log.total).toBe(1);
    expect(log.commits[0]).toMatchObject({
      hash: latest,
      subject: 'Summary',
      body: 'Body with ---END--- marker\nand another line',
      author: 'Workflow Test',
      authorEmail: 'workflow@example.invalid',
      files: ['space name.txt'],
    });
    expect((await getCommitLog(repository, Number.NaN)).total).toBe(2);
    expect((await getBranchCommitLog(repository, undefined, 0)).total).toBe(1);
    expect((await getBranchCommitLog(repository, 'main', 999)).branch).toBe('main');
  });

  it('deduplicates merge commits and retains files changed against both parents', async () => {
    await git('checkout', '-b', 'side');
    await commit('side.txt', 'side', 'Side change');
    await git('checkout', 'main');
    await commit('main.txt', 'main', 'Main change');
    await git('merge', '--no-ff', 'side', '-m', 'Integration');
    const head = await git('rev-parse', 'HEAD');
    for (const result of [
      await getCommitLog(repository, 100),
      await getBranchCommitLog(repository, 'main', 100),
    ]) {
      expect(result.commits.filter((entry) => entry.hash === head)).toHaveLength(1);
      expect(result.commits[0].files.sort()).toEqual(['main.txt', 'side.txt']);
      expect(result.total).toBe(4);
    }
  });
});

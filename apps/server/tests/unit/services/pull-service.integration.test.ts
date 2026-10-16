import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performPull } from '../../../src/services/pull-service.js';

const execFileAsync = promisify(execFile);
let root: string;
let writer: string;
let checkout: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (
    await execFileAsync('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  ).stdout.trim();
}

async function configure(repo: string): Promise<void> {
  await git(repo, 'config', 'user.name', 'Recovery test');
  await git(repo, 'config', 'user.email', 'recovery@example.invalid');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  await git(repo, 'config', 'pull.rebase', 'false');
}

async function commit(
  repo: string,
  file: string,
  contents: string,
  message: string
): Promise<void> {
  await writeFile(join(repo, file), contents);
  await git(repo, 'add', '--', file);
  await git(repo, 'commit', '-m', message);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'automaker-pull-recovery-'));
  writer = join(root, 'writer');
  checkout = join(root, 'checkout');
  const remote = join(root, 'remote.git');
  await git(root, 'init', '--bare', '--initial-branch=main', '--template=', remote);
  await git(root, 'clone', remote, writer);
  await configure(writer);
  await commit(writer, 'shared.txt', 'original\n', 'baseline');
  await commit(writer, 'local.txt', 'original local\n', 'local baseline');
  await git(writer, 'push', '-u', 'origin', 'main');
  await git(root, 'clone', remote, checkout);
  await configure(checkout);
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

describe('pull against temporary local Git remotes', () => {
  it('fast-forwards, restores tracked and untracked work, and preserves an older unrelated stash', async () => {
    await writeFile(join(checkout, 'local.txt'), 'older saved change\n');
    await git(checkout, 'stash', 'push', '-m', 'user-owned earlier stash');
    const originalStash = await git(checkout, 'rev-parse', 'refs/stash');
    await writeFile(join(checkout, 'local.txt'), 'current uncommitted edit\n');
    await writeFile(join(checkout, 'draft.txt'), 'untracked draft\n');
    await commit(writer, 'shared.txt', 'remote update\n', 'remote update');
    await git(writer, 'push');

    const result = await performPull(checkout, { stashIfNeeded: true });

    expect(result).toMatchObject({
      success: true,
      isFastForward: true,
      stashed: true,
      stashRestored: true,
    });
    expect(await git(checkout, 'rev-parse', 'HEAD')).toBe(await git(writer, 'rev-parse', 'HEAD'));
    expect(await readFile(join(checkout, 'local.txt'), 'utf8')).toBe('current uncommitted edit\n');
    expect(await readFile(join(checkout, 'draft.txt'), 'utf8')).toBe('untracked draft\n');
    expect(await git(checkout, 'rev-parse', 'refs/stash')).toBe(originalStash);
    expect(await git(checkout, 'stash', 'list', '--format=%s')).toBe(
      'On main: user-owned earlier stash'
    );
  });

  it('restores work without advancing HEAD when a local branch has no upstream', async () => {
    await git(checkout, 'checkout', '-b', 'local-only');
    const startingHead = await git(checkout, 'rev-parse', 'HEAD');
    await writeFile(join(checkout, 'local.txt'), 'work to preserve\n');
    await writeFile(join(checkout, 'draft.txt'), 'untracked work\n');

    expect(await performPull(checkout, { stashIfNeeded: true })).toMatchObject({
      success: false,
      error: expect.stringContaining('has no upstream branch'),
    });

    expect(await git(checkout, 'rev-parse', 'HEAD')).toBe(startingHead);
    expect(await readFile(join(checkout, 'local.txt'), 'utf8')).toBe('work to preserve\n');
    expect(await readFile(join(checkout, 'draft.txt'), 'utf8')).toBe('untracked work\n');
    expect(await git(checkout, 'stash', 'list')).toBe('');
  });

  it('keeps the auto-stash available until a conflicting pull merge is resolved', async () => {
    await commit(checkout, 'shared.txt', 'local committed branch\n', 'local divergence');
    await writeFile(join(checkout, 'local.txt'), 'uncommitted user edit\n');
    await commit(writer, 'shared.txt', 'remote committed branch\n', 'remote divergence');
    await git(writer, 'push');

    expect(await performPull(checkout, { stashIfNeeded: true })).toMatchObject({
      success: false,
      conflictSource: 'pull',
      conflictFiles: ['shared.txt'],
      stashed: true,
      stashRestored: false,
    });

    expect(await git(checkout, 'diff', '--name-only', '--diff-filter=U')).toBe('shared.txt');
    expect(await git(checkout, 'show', 'stash@{0}:local.txt')).toBe('uncommitted user edit');
    expect(await readFile(join(checkout, 'local.txt'), 'utf8')).toBe('original local\n');
  });

  it('retains the stash when remote changes conflict with the previously uncommitted work', async () => {
    await writeFile(join(checkout, 'shared.txt'), 'uncommitted user version\n');
    await commit(writer, 'shared.txt', 'remote version\n', 'remote change');
    await git(writer, 'push');

    expect(await performPull(checkout, { stashIfNeeded: true })).toMatchObject({
      success: true,
      pulled: true,
      conflictSource: 'stash',
      conflictFiles: ['shared.txt'],
      stashRestored: false,
    });

    expect(await git(checkout, 'rev-parse', 'HEAD')).toBe(await git(writer, 'rev-parse', 'HEAD'));
    expect(await git(checkout, 'diff', '--name-only', '--diff-filter=U')).toBe('shared.txt');
    expect(await git(checkout, 'show', 'stash@{0}:shared.txt')).toBe('uncommitted user version');
  });

  it('reports a real merge and its affected files for disjoint committed changes', async () => {
    await commit(checkout, 'local.txt', 'local committed update\n', 'local update');
    await commit(writer, 'shared.txt', 'remote committed update\n', 'remote update');
    await git(writer, 'push');

    expect(await performPull(checkout)).toMatchObject({
      success: true,
      pulled: true,
      isMerge: true,
      mergeAffectedFiles: ['shared.txt'],
    });

    expect((await git(checkout, 'show', '-s', '--format=%P', 'HEAD')).split(' ')).toHaveLength(2);
    expect(await readFile(join(checkout, 'local.txt'), 'utf8')).toBe('local committed update\n');
    expect(await readFile(join(checkout, 'shared.txt'), 'utf8')).toBe('remote committed update\n');
    expect(await git(checkout, 'status', '--porcelain')).toBe('');
  });
});

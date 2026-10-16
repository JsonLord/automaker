import { beforeEach, describe, expect, it, vi } from 'vitest';

const git = vi.hoisted(() => ({
  run: vi.fn(),
  retry: vi.fn(),
  branch: vi.fn(),
  conflicts: vi.fn(),
}));

vi.mock('@automaker/git-utils', () => ({
  execGitCommand: git.run,
  getConflictFiles: git.conflicts,
}));
vi.mock('../../../src/lib/git.js', () => ({
  execGitCommandWithLockRetry: git.retry,
  getCurrentBranch: git.branch,
}));

import {
  getLocalChanges,
  hasUpstreamOrRemoteBranch,
  performPull,
} from '../../../src/services/pull-service.js';

const root = '/project with spaces';
type GitBehavior = (args: string[]) => string | Promise<string>;
let behavior: GitBehavior;

beforeEach(() => {
  behavior = (args) => {
    if (args[0] === 'pull') return 'Already up to date.\n';
    if (args[0] === 'rev-parse') return 'origin/main\n';
    return '';
  };
  git.run.mockImplementation((args: string[]) => behavior(args));
  git.retry.mockResolvedValue('');
  git.branch.mockResolvedValue('main');
  git.conflicts.mockResolvedValue(['shared.ts']);
});

function change(overrides: Record<string, string | Error | object>) {
  const previous = behavior;
  behavior = (args) => {
    const value = overrides[args.join(' ')];
    if (value instanceof Error || (typeof value === 'object' && value !== null)) throw value;
    return value ?? previous(args);
  };
}

describe('pull user-work preservation', () => {
  it('reports complete unstaged, renamed and untracked paths before asking to stash', async () => {
    change({ 'status --porcelain': ' M src/edited.ts\nR  old.ts -> new.ts\n?? notes.txt\n' });
    const result = await performPull(root);
    expect(result).toMatchObject({
      success: true,
      pulled: false,
      hasLocalChanges: true,
      localChangedFiles: ['src/edited.ts', 'new.ts', 'notes.txt'],
    });
    expect(git.retry).not.toHaveBeenCalled();
    expect(git.run).not.toHaveBeenCalledWith(['pull'], root);
  });

  it('keeps a clean, up-to-date checkout unchanged', async () => {
    expect(await performPull(root)).toMatchObject({
      success: true,
      pulled: false,
      stashed: false,
      stashRestored: false,
      message: 'Already up to date',
    });
    expect(git.retry).not.toHaveBeenCalled();
  });

  it('stashes untracked files too and restores them after a fast-forward', async () => {
    change({ 'status --porcelain': '?? draft.md\n', pull: 'Updating a..b\nFast-forward\n' });
    expect(await performPull(root, { stashIfNeeded: true })).toMatchObject({
      success: true,
      pulled: true,
      isFastForward: true,
      stashed: true,
      stashRestored: true,
      hasConflicts: false,
    });
    expect(git.retry.mock.calls).toEqual([
      [
        [
          'stash',
          'push',
          '--include-untracked',
          '-m',
          'automaker-pull-stash: Pre-pull stash on main',
        ],
        root,
      ],
      [['stash', 'pop'], root],
    ]);
  });

  it('restores the newly created stash when no upstream or remote branch exists', async () => {
    change({
      'status --porcelain': '?? draft.md\n',
      'rev-parse --abbrev-ref main@{upstream}': new Error('no upstream'),
      'rev-parse --verify origin/main': new Error('unknown revision'),
    });
    const result = await performPull(root, { stashIfNeeded: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain('has no upstream branch');
    expect(result.stashRecoveryFailed).toBeUndefined();
    expect(git.retry).toHaveBeenLastCalledWith(['stash', 'pop'], root);
    expect(git.run).not.toHaveBeenCalledWith(['pull'], root);
  });

  it('reports retained work explicitly if upstream validation and stash recovery both fail', async () => {
    change({
      'status --porcelain': '?? draft.md\n',
      'rev-parse --abbrev-ref main@{upstream}': new Error('no upstream'),
      'rev-parse --verify origin/main': new Error('missing'),
    });
    git.retry.mockImplementation((args: string[]) => {
      if (args[1] === 'pop') throw new Error('worktree is unmerged');
      return '';
    });
    const result = await performPull(root, { stashIfNeeded: true });
    expect(result).toMatchObject({ success: false, stashRecoveryFailed: true });
    expect(result.error).toContain('Local changes remain stashed');
  });

  it('keeps the stash untouched while a pull merge conflict remains unresolved', async () => {
    change({
      'status --porcelain': '?? draft.md\n',
      pull: { stderr: 'CONFLICT (content): shared.ts' },
    });
    expect(await performPull(root, { stashIfNeeded: true })).toMatchObject({
      success: false,
      pulled: true,
      hasConflicts: true,
      conflictSource: 'pull',
      conflictFiles: ['shared.ts'],
      stashed: true,
      stashRestored: false,
    });
    expect(git.retry).not.toHaveBeenCalledWith(['stash', 'pop'], root);
  });

  it('still identifies a pull conflict when file enumeration is unavailable', async () => {
    change({ pull: { stdout: 'Automatic merge failed' } });
    git.conflicts.mockRejectedValue(new Error('index locked'));
    expect(await performPull(root)).toMatchObject({
      success: false,
      conflictSource: 'pull',
      conflictFiles: [],
      stashed: false,
    });
  });

  it('distinguishes successful pull from conflict while restoring user work', async () => {
    change({ 'status --porcelain': '?? draft.md\n', pull: 'Fast-forward' });
    git.retry.mockImplementation((args: string[]) => {
      if (args[1] === 'pop') throw { stdout: 'Merge conflict in shared.ts' };
      return '';
    });
    expect(await performPull(root, { stashIfNeeded: true })).toMatchObject({
      success: true,
      pulled: true,
      isFastForward: true,
      conflictSource: 'stash',
      hasConflicts: true,
      conflictFiles: ['shared.ts'],
      stashRestored: false,
    });
  });

  it('retains conflict evidence even when the stash-conflict file query fails', async () => {
    change({ 'status --porcelain': '?? draft.md\n', pull: 'Fast-forward' });
    git.retry.mockImplementation((args: string[]) => {
      if (args[1] === 'pop') throw { message: 'CONFLICT (content)' };
      return '';
    });
    git.conflicts.mockRejectedValue(new Error('index unavailable'));
    expect(await performPull(root, { stashIfNeeded: true })).toMatchObject({
      success: true,
      conflictSource: 'stash',
      conflictFiles: [],
      stashRestored: false,
    });
  });

  it('never claims a stash was restored after a non-conflict pop failure', async () => {
    change({ 'status --porcelain': '?? draft.md\n', pull: 'Fast-forward' });
    git.retry.mockImplementation((args: string[]) => {
      if (args[1] === 'pop') throw { stderr: 'index write failed' };
      return '';
    });
    const result = await performPull(root, { stashIfNeeded: true });
    expect(result).toMatchObject({
      success: true,
      pulled: true,
      hasConflicts: false,
      stashRestored: false,
    });
    expect(result.message).toContain('still in the stash list');
  });

  it.each([
    ['no tracking information for the current branch', false],
    ['transport connection lost', false],
    ['no tracking information for the current branch', true],
    ['transport connection lost', true],
  ])(
    'recovers stashed work after pull failure %s (recovery fails: %s)',
    async (message, recoveryFails) => {
      change({ 'status --porcelain': '?? draft.md\n', pull: { stderr: message } });
      git.retry.mockImplementation((args: string[]) => {
        if (args[1] === 'pop' && recoveryFails) throw new Error('index unavailable');
        return '';
      });
      const result = await performPull(root, { stashIfNeeded: true });
      expect(result.success).toBe(false);
      expect(result.stashRecoveryFailed).toBe(recoveryFails ? true : undefined);
      expect(result.error).toContain(
        message.startsWith('no tracking') ? 'has no upstream branch' : message
      );
      expect(git.retry).toHaveBeenLastCalledWith(['stash', 'pop'], root);
      if (recoveryFails) expect(result.error).toContain('manual recovery');
    }
  );

  it('does not pop an unrelated user stash after a failed pull without auto-stash', async () => {
    change({ pull: new Error('transport lost') });
    expect(await performPull(root)).toMatchObject({ success: false, error: 'transport lost' });
    expect(git.retry).not.toHaveBeenCalled();
  });
});

describe('pull branches and failure boundaries', () => {
  it('rejects detached HEAD before fetching or changing files', async () => {
    git.branch.mockResolvedValue('HEAD');
    expect(await performPull(root)).toMatchObject({
      success: false,
      error: expect.stringContaining('detached HEAD'),
    });
    expect(git.run).not.toHaveBeenCalled();
  });

  it('reports inability to inspect the current branch without fetching', async () => {
    git.branch.mockRejectedValue(new Error('not a repository'));
    expect(await performPull(root)).toMatchObject({
      success: false,
      error: 'Failed to get current branch: not a repository',
    });
    expect(git.run).not.toHaveBeenCalled();
  });

  it('stops on fetch failure before stashing local work', async () => {
    change({ 'fetch backup': new Error('remote unavailable') });
    expect(await performPull(root, { remote: 'backup', stashIfNeeded: true })).toMatchObject({
      success: false,
      error: "Failed to fetch from remote 'backup': remote unavailable",
    });
    expect(git.retry).not.toHaveBeenCalled();
  });

  it('stops if status cannot be read, preserving local work', async () => {
    change({ 'status --porcelain': new Error('permission denied') });
    expect(await performPull(root)).toMatchObject({
      success: false,
      error: 'Failed to get local changes: permission denied',
    });
    expect(git.run).not.toHaveBeenCalledWith(['pull'], root);
  });

  it('stops if auto-stash fails without attempting a pull or pop', async () => {
    change({ 'status --porcelain': '?? draft.md\n' });
    git.retry.mockRejectedValue(new Error('index locked'));
    expect(await performPull(root, { stashIfNeeded: true })).toMatchObject({
      success: false,
      error: 'Failed to stash local changes: index locked',
    });
    expect(git.retry).toHaveBeenCalledTimes(1);
    expect(git.run).not.toHaveBeenCalledWith(['pull'], root);
  });

  it('pulls a named remote branch as an individual argument and skips tracking lookup', async () => {
    await performPull(root, { remote: 'upstream', remoteBranch: 'release;$(touch marker)' });
    expect(git.run).toHaveBeenCalledWith(['pull', 'upstream', 'release;$(touch marker)'], root);
    expect(git.run.mock.calls.some(([args]) => args[0] === 'rev-parse')).toBe(false);
  });

  it('uses the existing remote branch explicitly when local tracking is absent', async () => {
    change({ 'rev-parse --abbrev-ref main@{upstream}': new Error('no upstream') });
    expect(await performPull(root)).toMatchObject({ success: true });
    expect(git.run).toHaveBeenCalledWith(['pull', 'origin', 'main'], root);
  });

  it('reports merge affected files based on commit parents, independent of pull output language', async () => {
    change({
      pull: 'Zusammengeführt.\n',
      'show -s --pretty=%P HEAD': 'aaaa bbbb\n',
      'diff --name-only HEAD~1 HEAD': 'src/main.ts\nnew file.txt\n',
    });
    expect(await performPull(root)).toMatchObject({
      success: true,
      pulled: true,
      isMerge: true,
      mergeAffectedFiles: ['src/main.ts', 'new file.txt'],
    });
  });

  it('keeps merge and restored-work evidence when affected-file enumeration fails', async () => {
    change({
      'status --porcelain': '?? draft.md\n',
      pull: 'Merge made by the ort strategy.',
      'show -s --pretty=%P HEAD': 'aaaa bbbb',
      'diff --name-only HEAD~1 HEAD': new Error('object missing'),
    });
    expect(await performPull(root, { stashIfNeeded: true })).toMatchObject({
      success: true,
      isMerge: true,
      mergeAffectedFiles: [],
      stashRestored: true,
    });
  });

  it.each(['aaaa\n', ''])(
    'does not call a single-parent or root commit a merge (%s)',
    async (parents) => {
      change({ pull: 'Updated checkout.', 'show -s --pretty=%P HEAD': parents });
      const result = await performPull(root);
      expect(result.success).toBe(true);
      expect(result.isMerge).toBeUndefined();
    }
  );

  it('does not claim a merge when commit inspection fails', async () => {
    change({ pull: 'Updated checkout.', 'show -s --pretty=%P HEAD': new Error('missing object') });
    expect((await performPull(root)).isMerge).toBeUndefined();
  });

  it('returns no local changes for whitespace-only status output', async () => {
    change({ 'status --porcelain': '\n  \n' });
    expect(await getLocalChanges(root)).toEqual({ hasLocalChanges: false, localChangedFiles: [] });
  });

  it('distinguishes absent upstream from a configured tracking ref', async () => {
    expect(await hasUpstreamOrRemoteBranch(root, 'main', 'origin')).toBe('tracking');
    expect(git.run).not.toHaveBeenCalledWith(['rev-parse', '--verify', 'origin/main'], root);
  });
});

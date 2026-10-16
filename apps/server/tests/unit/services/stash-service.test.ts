import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventEmitter } from '../../../src/lib/events.js';

const git = vi.hoisted(() => ({ run: vi.fn(), retry: vi.fn() }));
vi.mock('../../../src/lib/git.js', () => ({
  execGitCommand: git.run,
  execGitCommandWithLockRetry: git.retry,
}));

import {
  applyOrPop,
  dropStash,
  getConflictedFiles,
  listStash,
  pushStash,
} from '../../../src/services/stash-service.js';

const root = '/project with spaces';
let events: EventEmitter;

beforeEach(() => {
  git.run.mockResolvedValue('');
  git.retry.mockResolvedValue('');
  events = { emit: vi.fn(), subscribe: vi.fn() };
});

describe('stash apply/pop recovery contracts', () => {
  it.each([
    [undefined, 'apply', 'applied'],
    [{ pop: false }, 'apply', 'applied'],
    [{ pop: true }, 'pop', 'popped'],
  ] as const)('targets only the requested stash using %s', async (options, operation, verb) => {
    git.run.mockResolvedValue('Changes restored.');
    expect(await applyOrPop(root, 3, options, events)).toEqual({
      success: true,
      applied: true,
      hasConflicts: false,
      operation,
      stashIndex: 3,
      message: `Stash ${verb} successfully`,
    });
    expect(git.run).toHaveBeenCalledWith(['stash', operation, 'stash@{3}'], root);
    expect(git.run).toHaveBeenCalledTimes(1);
    expect(vi.mocked(events.emit).mock.calls.map(([name]) => name)).toEqual([
      'stash:start',
      'stash:progress',
      'stash:success',
    ]);
  });

  it.each([
    ['stdout', 'CONFLICT (content): Merge conflict in src/file.ts'],
    ['stderr', 'Merge conflict in src/file.ts'],
    ['message', 'CONFLICT in src/file.ts'],
  ])(
    'recognizes conflict from failing Git %s without dropping recovery evidence',
    async (field, output) => {
      git.run.mockImplementation((args: string[]) => {
        if (args[0] === 'stash') throw { [field]: output };
        return 'src/file.ts\nsrc/other.ts\n';
      });
      expect(await applyOrPop(root, 2, { pop: true }, events)).toMatchObject({
        success: true,
        applied: true,
        hasConflicts: true,
        conflictFiles: ['src/file.ts', 'src/other.ts'],
        operation: 'pop',
        stashIndex: 2,
      });
      expect(vi.mocked(events.emit).mock.calls.map(([name]) => name)).toEqual([
        'stash:start',
        'stash:progress',
        'stash:conflicts',
        'stash:success',
      ]);
      expect(git.run).not.toHaveBeenCalledWith(['stash', 'drop', 'stash@{2}'], root);
      expect(events.emit).not.toHaveBeenCalledWith('stash:failure', expect.anything());
    }
  );

  it('recognizes conflict output even when Git reports exit zero', async () => {
    git.run.mockImplementation((args: string[]) =>
      args[0] === 'stash' ? 'CONFLICT (content)' : 'a.ts\n'
    );
    expect(await applyOrPop(root, 0)).toMatchObject({
      hasConflicts: true,
      conflictFiles: ['a.ts'],
    });
  });

  it('reports conflict honestly when enumeration itself fails', async () => {
    git.run.mockImplementation((args: string[]) => {
      if (args[0] === 'stash') throw { stderr: 'CONFLICT (content)' };
      throw new Error('cannot read index');
    });
    expect(await applyOrPop(root, 0, { pop: false }, events)).toMatchObject({
      success: true,
      hasConflicts: true,
      conflictFiles: [],
    });
  });

  it.each([
    new Error('stash@{4} does not exist'),
    { stderr: 'fatal: bad revision', message: 'command failed' },
    { stdout: 'no stash found' },
  ])('reports non-conflict errors without claiming work was restored', async (error) => {
    git.run.mockRejectedValue(error);
    const result = await applyOrPop(root, 4, undefined, events);
    expect(result).toMatchObject({
      success: false,
      applied: false,
      operation: 'apply',
      stashIndex: 4,
    });
    expect(typeof result.error).toBe('string');
    expect(vi.mocked(events.emit).mock.calls.map(([name]) => name)).toEqual([
      'stash:start',
      'stash:progress',
      'stash:failure',
    ]);
    expect(git.run).toHaveBeenCalledTimes(1);
  });

  it('returns only unresolved paths, dropping empty diff lines', async () => {
    git.run.mockResolvedValue('src/first.ts\n\nsrc/space name.ts\n');
    expect(await getConflictedFiles(root)).toEqual(['src/first.ts', 'src/space name.ts']);
    expect(git.run).toHaveBeenCalledWith(['diff', '--name-only', '--diff-filter=U'], root);
  });

  it('returns an empty unresolved list for a clean index', async () => {
    expect(await getConflictedFiles(root)).toEqual([]);
  });
});

describe('stash creation', () => {
  it('does not create or inspect a stash when there are no changes', async () => {
    expect(await pushStash(root, undefined, events)).toEqual({
      success: true,
      stashed: false,
      message: 'No changes to stash',
    });
    expect(git.retry).not.toHaveBeenCalled();
    expect(git.run).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith('stash:success', {
      worktreePath: root,
      operation: 'push',
      stashed: false,
    });
  });

  it('includes untracked work by default and uses the checked-out branch as the message', async () => {
    git.run.mockImplementation((args: string[]) =>
      args[0] === 'status' ? '?? notes.txt\n' : 'feature/data\n'
    );
    expect(await pushStash(root)).toEqual({
      success: true,
      stashed: true,
      branch: 'feature/data',
      message: 'WIP on feature/data',
    });
    expect(git.retry).toHaveBeenCalledWith(['stash', 'push', '--include-untracked'], root);
  });

  it('keeps a supplied message and filenames as separate arguments behind pathspec separator', async () => {
    git.run.mockImplementation((args: string[]) =>
      args[0] === 'status' ? ' M src/main.ts\n' : 'main\n'
    );
    const message = '  save $(touch marker); draft  ';
    const files = ['--all', 'src/space name.ts', '$(touch other)'];
    const result = await pushStash(root, { message, files }, events);
    expect(result.message).toBe('save $(touch marker); draft');
    expect(git.retry).toHaveBeenCalledWith(
      ['stash', 'push', '--include-untracked', '-m', 'save $(touch marker); draft', '--', ...files],
      root
    );
  });

  it('does not supply empty message or empty pathspec arguments', async () => {
    git.run.mockImplementation((args: string[]) =>
      args[0] === 'status' ? '?? draft\n' : 'main\n'
    );
    expect((await pushStash(root, { message: '  ', files: [] })).message).toBe('WIP on main');
    expect(git.retry).toHaveBeenCalledWith(['stash', 'push', '--include-untracked'], root);
  });

  it('propagates a failed stash write without announcing successful preservation', async () => {
    git.run.mockResolvedValue('?? draft\n');
    git.retry.mockRejectedValue(new Error('index locked'));
    await expect(pushStash(root, undefined, events)).rejects.toThrow('index locked');
    expect(events.emit).not.toHaveBeenCalledWith('stash:success', expect.anything());
    expect(git.run).toHaveBeenCalledTimes(1);
  });

  it('propagates a status failure before attempting to change the repository', async () => {
    git.run.mockRejectedValue(new Error('not a repository'));
    await expect(pushStash(root)).rejects.toThrow('not a repository');
    expect(git.retry).not.toHaveBeenCalled();
  });
});

describe('stash inventory and deletion', () => {
  it('reports an empty inventory without attempting stash show', async () => {
    expect(await listStash(root)).toEqual({ success: true, stashes: [], total: 0 });
    expect(git.run).toHaveBeenCalledTimes(1);
  });

  it('preserves independent stash indices, branches, dates and filenames', async () => {
    const date = '2026-10-15T12:00:00+02:00';
    git.run.mockImplementation((args: string[]) => {
      if (args[1] === 'list')
        return [
          `stash@{0}|||WIP on main: abc123 draft|||${date}`,
          `stash@{3}|||On feature/data: checkpoint|||${date}`,
          `stash@{5}|||custom imported stash|||${date}`,
        ].join('\n');
      if (args[2] === 'stash@{0}') return 'src/a.ts\nspace name.txt\n';
      if (args[2] === 'stash@{3}') return 'src/b.ts\n';
      return '';
    });
    expect(await listStash(root)).toEqual({
      success: true,
      total: 3,
      stashes: [
        {
          index: 0,
          branch: 'main',
          message: 'WIP on main: abc123 draft',
          date,
          files: ['src/a.ts', 'space name.txt'],
        },
        {
          index: 3,
          branch: 'feature/data',
          message: 'On feature/data: checkpoint',
          date,
          files: ['src/b.ts'],
        },
        { index: 5, branch: '', message: 'custom imported stash', date, files: [] },
      ],
    });
  });

  it('preserves delimiter text inside a user stash message without corrupting its date', async () => {
    git.run.mockImplementation((args: string[]) =>
      args[1] === 'list'
        ? 'stash@{0}|||On main: before ||| after|||2026-10-15T10:00:00Z\n'
        : 'draft.txt\n'
    );
    expect((await listStash(root)).stashes).toEqual([
      {
        index: 0,
        branch: 'main',
        message: 'On main: before ||| after',
        date: '2026-10-15T10:00:00Z',
        files: ['draft.txt'],
      },
    ]);
  });

  it('skips malformed inventory rows and keeps metadata if a valid stash cannot be inspected', async () => {
    git.run.mockImplementation((args: string[]) => {
      if (args[1] === 'list')
        return '\nmissing fields\nnot-a-stash|||message|||date\nstash@{2}|||On main: draft|||2026-10-15T10:00:00Z\n';
      throw new Error('object unavailable');
    });
    const result = await listStash(root);
    expect(result.total).toBe(1);
    expect(result.stashes[0]).toMatchObject({ index: 2, files: [], message: 'On main: draft' });
  });

  it('does not present a Git inventory failure as an empty stash list', async () => {
    git.run.mockRejectedValue(new Error('cannot read reflog'));
    await expect(listStash(root)).rejects.toThrow('cannot read reflog');
  });

  it('drops only the explicitly selected stash and emits completion afterwards', async () => {
    expect(await dropStash(root, 4, events)).toMatchObject({
      success: true,
      dropped: true,
      stashIndex: 4,
    });
    expect(git.run.mock.calls).toEqual([[['stash', 'drop', 'stash@{4}'], root]]);
    expect(vi.mocked(events.emit).mock.calls.map(([name]) => name)).toEqual([
      'stash:start',
      'stash:success',
    ]);
  });

  it('never emits successful deletion when Git refuses the requested stash', async () => {
    git.run.mockRejectedValue(new Error('stash@{9} does not exist'));
    await expect(dropStash(root, 9, events)).rejects.toThrow('does not exist');
    expect(events.emit).not.toHaveBeenCalledWith('stash:success', expect.anything());
    expect(git.run).toHaveBeenCalledTimes(1);
  });
});

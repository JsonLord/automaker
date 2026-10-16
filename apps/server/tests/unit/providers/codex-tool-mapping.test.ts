import { describe, expect, it } from 'vitest';
import {
  extractCodexTodoItems,
  getCodexTodoToolName,
  resolveCodexToolCall,
} from '@/providers/codex-tool-mapping.js';

describe('Codex command display mapping', () => {
  it.each([
    ['cat README.md', 'Read', { file_path: 'README.md' }],
    ['head -n 20 "docs/user guide.md"', 'Read', { file_path: 'docs/user guide.md' }],
    ["tail 'docs/user guide.md'", 'Read', { file_path: 'docs/user guide.md' }],
    ['cat docs/user\\ guide.md', 'Read', { file_path: 'docs/user guide.md' }],
    ['stat', 'Read', {}],
    ["sed -n '1,20p' src/index.ts", 'Read', { file_path: 'src/index.ts' }],
    ["sed -i 's/before/after/g' src/index.ts", 'Edit', { file_path: 'src/index.ts' }],
    ["sed --in-place 's/before/after/g' src/index.ts", 'Edit', { file_path: 'src/index.ts' }],
    ["sed -i.bak 's/before/after/g' src/index.ts", 'Edit', { file_path: 'src/index.ts' }],
    ["perl -pi -e 's/before/after/g' src/index.ts", 'Edit', { file_path: 'src/index.ts' }],
    ['touch src/new-file.ts', 'Write', { file_path: 'src/new-file.ts' }],
    ['mkdir -p docs/new', 'Write', { file_path: 'docs/new' }],
    ['tee output.txt', 'Write', { file_path: 'output.txt' }],
    ['tee', 'Write', {}],
    ["echo 'new text' > output.txt", 'Write', { file_path: 'output.txt' }],
    ["printf 'more text' >> output.txt", 'Write', { file_path: 'output.txt' }],
    ['ls -la', 'Ls', { path: '.' }],
    ['dir docs', 'Ls', { path: 'docs' }],
    ['ll docs', 'Ls', { path: 'docs' }],
    ['find src -name *.ts', 'Glob', { pattern: '*.ts' }],
    ['fd', 'Glob', {}],
    ['rg --files -g *.ts', 'Glob', { pattern: '*.ts' }],
    ['rg --files', 'Glob', {}],
    [
      'rg -n --glob *.ts --type-add custom:*.foo --encoding utf-8 needle src',
      'Grep',
      { pattern: 'needle' },
    ],
    ['grep -e "two words" README.md', 'Grep', { pattern: 'two words' }],
    ['rg --regexp pattern src', 'Grep', { pattern: 'pattern' }],
    ['rg -- -literal src', 'Grep', { pattern: '-literal' }],
    ['rg -n', 'Grep', {}],
    ['rg --', 'Grep', {}],
    ['rg --regexp', 'Grep', {}],
    ['rg --glob *.ts', 'Grep', {}],
    ['rm old-file.txt', 'Delete', { path: 'old-file.txt' }],
    ['unlink -- old-file.txt', 'Delete', { path: 'old-file.txt' }],
    ['del old-file.txt', 'Delete', { path: 'old-file.txt' }],
  ])('represents %s as %s with useful display metadata', (command, name, input) => {
    expect(resolveCodexToolCall(command as string)).toEqual({ name, input });
  });

  it.each([
    'rm -rf old-directory',
    'rm -r old-directory',
    'rm -f old-file.txt',
    'rm',
    'npm test',
    '',
  ])('preserves the complete command for a general shell operation (%s)', (command) => {
    expect(resolveCodexToolCall(command)).toEqual({ name: 'Bash', input: { command } });
  });

  it.each([
    '/bin/bash -lc "cat README.md"',
    "bash -lc 'cat README.md'",
    '/bin/sh -lc "cat README.md"',
    "sh -lc 'cat README.md'",
    'cmd.exe /c cat README.md',
    'powershell.exe -Command cat README.md',
    'pwsh -Command cat README.md',
  ])('recognizes a read command inside the supported shell wrapper (%s)', (command) => {
    expect(resolveCodexToolCall(command)).toEqual({
      name: 'Read',
      input: { file_path: 'README.md' },
    });
  });

  it('unwraps an escaped quoted path and leading working-directory/environment setup', () => {
    expect(
      resolveCodexToolCall(
        '/bin/bash -lc "cd /repo && export MODE=test; cat \\"docs/user guide.md\\""'
      )
    ).toEqual({ name: 'Read', input: { file_path: 'docs/user guide.md' } });
  });

  it('handles command wrappers without treating them as filenames', () => {
    expect(resolveCodexToolCall('sudo command cat README.md')).toEqual({
      name: 'Read',
      input: { file_path: 'README.md' },
    });
  });

  it('retains an initialization-only command when there is no operation to summarize', () => {
    const command = 'cd /repo && export MODE=test';
    expect(resolveCodexToolCall(command)).toEqual({ name: 'Bash', input: { command } });
  });

  it.each(['Update File', 'Add File', 'Delete File', 'Move to'])(
    'extracts the affected path from an apply_patch %s record',
    (operation) => {
      expect(
        resolveCodexToolCall(
          `apply_patch <<'PATCH'\n*** Begin Patch\n*** ${operation}: src/file.ts\n*** End Patch\nPATCH`
        )
      ).toEqual({ name: 'Edit', input: { file_path: 'src/file.ts' } });
    }
  );

  it('extracts a final unterminated patch line', () => {
    expect(resolveCodexToolCall('apply_patch\n*** Add File: src/file.ts')).toEqual({
      name: 'Edit',
      input: { file_path: 'src/file.ts' },
    });
  });

  it.each(['apply_patch', 'apply_patch\n*** Add File: \n*** End Patch'])(
    'retains edit intent when the patch does not identify a path (%s)',
    (command) => {
      expect(resolveCodexToolCall(command)).toEqual({ name: 'Edit', input: {} });
    }
  );
});

describe('Codex todo event compatibility', () => {
  it('accepts mixed string and structured SDK todo items, preserving supported statuses', () => {
    expect(
      extractCodexTodoItems({
        todos: [
          'Document deployment',
          {
            content: 'Investigate failure',
            status: 'in_progress',
            activeForm: 'Investigating failure',
          },
          { text: 'Reproduce failure', status: 'completed' },
          { title: 'Write regression test', status: 'pending' },
          { content: 'Review change', status: 'unknown', activeForm: 42 },
          null,
          42,
          {},
          { content: 42 },
        ],
      })
    ).toEqual([
      { content: 'Document deployment', status: 'pending' },
      {
        content: 'Investigate failure',
        status: 'in_progress',
        activeForm: 'Investigating failure',
      },
      { content: 'Reproduce failure', status: 'completed', activeForm: undefined },
      { content: 'Write regression test', status: 'pending', activeForm: undefined },
      { content: 'Review change', status: 'pending', activeForm: undefined },
    ]);
    expect(getCodexTodoToolName()).toBe('TodoWrite');
  });

  it('supports the alternate items field used by todo events', () => {
    expect(
      extractCodexTodoItems({ items: [{ title: 'Test change', status: 'in_progress' }] })
    ).toEqual([{ content: 'Test change', status: 'in_progress', activeForm: undefined }]);
  });

  it.each(['text', 'content'])(
    'parses Markdown checklists from %s while ignoring prose',
    (field) => {
      expect(
        extractCodexTodoItems({
          [field]:
            '\nPlan for this change:\n - [x] Reproduce issue\n* [~] Fix cause\n- [ ] Test change\n* Document behavior\n',
        })
      ).toEqual([
        { content: 'Reproduce issue', status: 'completed' },
        { content: 'Fix cause', status: 'in_progress' },
        { content: 'Test change', status: 'pending' },
        { content: 'Document behavior', status: 'pending' },
      ]);
    }
  );

  it.each([
    {},
    { todos: [] },
    { todos: [null, 42, { content: '' }] },
    { items: [] },
    { items: [false, {}] },
    { text: '' },
    { text: 'There is no checklist in this response.' },
    { text: 42, content: false },
  ])('returns no synthetic tasks when the event has no usable todos (%j)', (event) => {
    expect(extractCodexTodoItems(event)).toBeNull();
  });

  it('uses the authoritative structured todos rather than stale alternate or text fields', () => {
    expect(
      extractCodexTodoItems({
        todos: [{ content: 'Current task', status: 'completed' }],
        items: ['Stale task'],
        text: '- [ ] Older task',
      })
    ).toEqual([{ content: 'Current task', status: 'completed', activeForm: undefined }]);
  });
});

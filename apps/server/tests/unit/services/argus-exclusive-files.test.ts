import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { writeAtomicFileExclusive } from '../../../src/services/argus/durable-store.js';
import { ensureArgusControlFiles } from '../../../src/services/argus/project-lifecycle.js';

const exec = promisify(execFile);
const moduleUrl = pathToFileURL(
  path.resolve('apps/server/src/services/argus/durable-store.ts')
).href;
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-no-clobber-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
function child(file: string, content: string, crash?: 'before' | 'after') {
  return exec(
    process.execPath,
    [
      '--import',
      path.resolve('node_modules/tsx/dist/loader.mjs'),
      '--input-type=module',
      '-e',
      `
    import fs from 'node:fs/promises';
    import { writeAtomicFileExclusive } from ${JSON.stringify(moduleUrl)};
    const original = fs.link;
    fs.link = async (...args) => {
      if (${JSON.stringify(crash)} === 'before') process.kill(process.pid, 'SIGKILL');
      const result = await original(...args);
      if (${JSON.stringify(crash)} === 'after') process.kill(process.pid, 'SIGKILL');
      return result;
    };
    await writeAtomicFileExclusive(${JSON.stringify(file)}, ${JSON.stringify(content)});
  `,
    ],
    { timeout: 20000 }
  );
}
describe('Argus control-file atomic no-clobber publication', () => {
  it('publishes exactly one complete inode across separate concurrent processes', async () => {
    const file = path.join(root, 'spec.md');
    const candidates = Array.from(
      { length: 8 },
      (_, i) => `writer-${i}\n` + String(i).repeat(100000)
    );
    await Promise.all(candidates.map((content) => child(file, content)));
    expect(candidates).toContain(await fs.readFile(file, 'utf8'));
    expect(await fs.readdir(root)).toEqual(['spec.md']);
  }, 30000);
  it.each(['', 'existing specification'])(
    'preserves existing file byte-for-byte: %j',
    async (content) => {
      const file = path.join(root, 'spec.md');
      await fs.writeFile(file, content);
      const before = await fs.stat(file);
      await Promise.all([
        child(file, 'replacement'),
        writeAtomicFileExclusive(file, 'another replacement'),
      ]);
      expect(await fs.readFile(file, 'utf8')).toBe(content);
      expect((await fs.stat(file)).ino).toBe(before.ino);
      expect(await fs.readdir(root)).toEqual(['spec.md']);
    }
  );
  it.each([false, true])(
    'preserves an existing symlink, including a dangling link: %s',
    async (dangling) => {
      const target = path.join(root, 'target');
      const file = path.join(root, 'spec.md');
      if (!dangling) await fs.writeFile(target, 'untouched target');
      await fs.symlink(target, file);
      await writeAtomicFileExclusive(file, 'must not follow or replace');
      expect((await fs.lstat(file)).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(file)).toBe(target);
      if (!dangling) expect(await fs.readFile(target, 'utf8')).toBe('untouched target');
      else await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );
  it.each(['before', 'after'] as const)(
    'recovers by retry without promoting stale data after a crash %s publication',
    async (crash) => {
      const file = path.join(root, 'spec.md');
      await expect(child(file, 'fully synced first writer', crash)).rejects.toMatchObject({
        signal: 'SIGKILL',
      });
      await writeAtomicFileExclusive(file, 'retry writer');
      expect(await fs.readFile(file, 'utf8')).toBe(
        crash === 'after' ? 'fully synced first writer' : 'retry writer'
      );
      const orphans = (await fs.readdir(root)).filter((name) => name.includes('.tmp.'));
      expect(orphans).toHaveLength(1); // Crash-left private names are harmless, never authoritative or replayed.
      expect(await fs.readFile(path.join(root, orphans[0]), 'utf8')).toBe(
        'fully synced first writer'
      );
    }
  );
  it('wires no-clobber creation into all three control files, even when empty', async () => {
    await fs.mkdir(path.join(root, '.automaker'));
    const files = ['ARGUS.md', 'spec.md', '.automaker/argus.yaml'];
    for (const name of files) await fs.writeFile(path.join(root, name), '');
    await ensureArgusControlFiles(root, 'new spec', 'new objective');
    for (const name of files) expect(await fs.readFile(path.join(root, name), 'utf8')).toBe('');
  });
  it('does not invent a specification or charter when an import has no objective', async () => {
    await ensureArgusControlFiles(root, '', '');
    for (const file of ['spec.md', 'ARGUS.md'])
      await expect(fs.stat(path.join(root, file))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertCleanWorkingTree } from '../check-clean-working-tree.mjs';

function fixture(t) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'automaker-clean-tree-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' });
  git('init', '--quiet');
  writeFileSync(path.join(cwd, 'source.txt'), 'committed source\n');
  git('add', 'source.txt');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'Fixture'
  );
  return { cwd, git };
}

test('allows a clean checkout and untracked files without changing status', (t) => {
  const { cwd, git } = fixture(t);
  writeFileSync(path.join(cwd, '.env'), 'fixture-only-secret');
  const before = git('status', '--porcelain=v1', '-z');
  assert.doesNotThrow(() => assertCleanWorkingTree('Install', cwd));
  assert.equal(git('status', '--porcelain=v1', '-z'), before);
});

test('rejects tracked modifications with a phase and filename, without source contents', (t) => {
  const { cwd, git } = fixture(t);
  const sensitiveFixtureContent = 'fixture-source-contents-must-not-appear';
  writeFileSync(path.join(cwd, 'source.txt'), sensitiveFixtureContent);
  const before = git('status', '--porcelain=v1', '-z');
  assert.throws(
    () => assertCleanWorkingTree('UI build', cwd),
    (error) =>
      error.message.includes('UI build changed tracked source') &&
      error.message.includes(' M "source.txt"') &&
      !error.message.includes(sensitiveFixtureContent)
  );
  assert.equal(git('status', '--porcelain=v1', '-z'), before);
});

test('reports both staged rename paths and safely escapes unusual filenames', (t) => {
  const { cwd, git } = fixture(t);
  const target = 'renamed\nsource.txt';
  git('mv', 'source.txt', target);
  const before = git('status', '--porcelain=v1', '-z');
  assert.throws(
    () => assertCleanWorkingTree('Tests', cwd),
    (error) =>
      error.message.includes(JSON.stringify(target)) &&
      error.message.includes('(from "source.txt")')
  );
  assert.equal(git('status', '--porcelain=v1', '-z'), before);
});

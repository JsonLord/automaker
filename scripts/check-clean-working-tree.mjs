#!/usr/bin/env node
// Report paths and status only; source contents may contain confidential information.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function assertCleanWorkingTree(label = 'Validation', cwd = process.cwd()) {
  const records = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=no'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean);
  const changes = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const status = record.slice(0, 2);
    const filename = record.slice(3);
    // In porcelain -z output, a rename is followed by its original pathname.
    const original = /[RC]/.test(status) ? records[++index] : undefined;
    changes.push(
      `${status} ${JSON.stringify(filename)}${original ? ` (from ${JSON.stringify(original)})` : ''}`
    );
  }
  if (changes.length) {
    throw new Error(
      `${label} changed tracked source. Commit the intended source changes before exporting; ` +
        `validation must not rewrite tracked files:\n${changes.join('\n')}`
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assertCleanWorkingTree(process.argv[2]);
}

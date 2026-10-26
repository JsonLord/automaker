#!/usr/bin/env node
// Export committed source only. Never includes local credentials or persistent campaign data.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { manifestName, treeHash } from './release-identity.mjs';
import path from 'node:path';
import { assertCleanWorkingTree } from './check-clean-working-tree.mjs';
const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
const output = path.resolve(process.argv[2] || '/tmp/automaker-hf.tar');
const sha = git('rev-parse', 'HEAD');
assertCleanWorkingTree('Deployment export');
const files = git('ls-tree', '-r', '--name-only', 'HEAD').split('\n');
const forbidden = files.filter(
  (f) =>
    /(^|\/)(\.automaker|\.aws|\.ssh|node_modules|data)(\/|$)/.test(f) ||
    (/(^|\/)\.env(?:\.|$)/.test(f) && !f.endsWith('.example')) ||
    (f !== '.npmrc' && /(^|\/)(id_rsa|id_ed25519|credentials|\.npmrc)$/.test(f)) ||
    /\.(pem|key|p12)$/.test(f)
);
if (
  files.includes('.npmrc') &&
  git('show', 'HEAD:.npmrc')
    .split('\n')
    .some((line) => line.trim() && !/^[#;]/.test(line.trim()))
)
  throw new Error('Root .npmrc must contain comments only for this deployment export');
if (forbidden.length) throw new Error(`Forbidden files tracked in source: ${forbidden.join(', ')}`);
for (const required of [
  'Dockerfile',
  'entrypoint.sh',
  'update_settings.py',
  'package.json',
  'package-lock.json',
  'scripts/argus_runtime_bridge.py',
  'apps/server/package.json',
  'apps/ui/package.json',
  'libs/types/package.json',
])
  if (!files.includes(required)) throw new Error(`Required deployment source missing: ${required}`);
if (files.includes(manifestName) || files.includes('build-provenance.json'))
  throw new Error('Generated release manifests must never be tracked');
const entries = execFileSync('git', ['ls-tree', '-rz', 'HEAD'])
  .toString('utf8')
  .split('\0')
  .filter(Boolean)
  .map((line) => {
    const match = /^(\d+) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(line);
    if (!match) throw new Error('Unsupported Git tree entry');
    return { mode: match[1], oid: match[2], path: match[3] };
  });
const commit = execFileSync('git', ['cat-file', 'commit', sha]);
if (treeHash(entries) !== git('rev-parse', 'HEAD^{tree}')) throw new Error('Release tree mismatch');
const buildTimestamp = new Date(
  Number(git('show', '-s', '--format=%ct', 'HEAD')) * 1000
).toISOString();
const manifest = {
  schema: 1,
  sourceSha: sha,
  buildTimestamp,
  commitBase64: commit.toString('base64'),
  files: entries,
};
// git archive uses stable tree ordering and commit timestamps. Preserve all apps/** and libs/**.
execFileSync('git', ['-c', 'tar.umask=0022', 'archive', '--format=tar', `--output=${output}`, sha]);
const temp = mkdtempSync(path.join(os.tmpdir(), 'argus-release-'));
try {
  writeFileSync(path.join(temp, manifestName), JSON.stringify(manifest, null, 2) + '\n', {
    mode: 0o644,
  });
  execFileSync('tar', [
    '--append',
    '--file',
    output,
    '--format=ustar',
    '--mtime',
    buildTimestamp,
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '-C',
    temp,
    manifestName,
  ]);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
const provenance = {
  gitSha: sha,
  buildTimestamp,
  sha256: createHash('sha256').update(readFileSync(output)).digest('hex'),
  format: 'git-archive-tar',
  sourceFiles: files.length,
};
writeFileSync(`${output}.provenance.json`, `${JSON.stringify(provenance, null, 2)}\n`, {
  mode: 0o600,
});
console.log(JSON.stringify({ output, ...provenance }));

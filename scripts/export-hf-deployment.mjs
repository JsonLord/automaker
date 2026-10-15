#!/usr/bin/env node
// Export committed source only. Never includes local credentials or persistent campaign data.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
const output = path.resolve(process.argv[2] || '/tmp/automaker-hf.tar');
const sha = git('rev-parse', 'HEAD');
if (git('status', '--porcelain', '--untracked-files=no'))
  throw new Error('Commit tracked changes before exporting deployment source');
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
// git archive uses stable tree ordering and commit timestamps. Preserve all apps/** and libs/**.
execFileSync('git', ['archive', '--format=tar', `--output=${output}`, sha]);
const provenance = {
  gitSha: sha,
  buildTimestamp: git('show', '-s', '--format=%cI', 'HEAD'),
  sha256: createHash('sha256').update(readFileSync(output)).digest('hex'),
  format: 'git-archive-tar',
  sourceFiles: files.length,
};
writeFileSync(`${output}.provenance.json`, `${JSON.stringify(provenance, null, 2)}\n`, {
  mode: 0o600,
});
console.log(JSON.stringify({ output, ...provenance }));

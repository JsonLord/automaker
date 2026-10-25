#!/bin/sh
set -eu
# Override only for isolated build/test fixtures; Docker uses the default path.
export PROVENANCE_FILE="${PROVENANCE_FILE:-/app/apps/server/dist/assets/build-provenance.json}"
node --input-type=module <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const git = args => { try { return execFileSync('git', args, {encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(); } catch { return null; } };

let fallbackSha = null;
let fallbackTime = null;
try {
  const rootProv = JSON.parse(fs.readFileSync('build-provenance.json', 'utf8'));
  fallbackSha = rootProv.gitSha;
  fallbackTime = rootProv.buildTimestamp;
} catch {
  // ignore
}

const candidate = process.env.BUILD_GIT_SHA || git(['rev-parse','HEAD']) || fallbackSha;
const gitSha = /^(?!0{40}$)[0-9a-f]{40}$/i.test(candidate || '') ? candidate.toLowerCase() : null;
const timestamp = process.env.BUILD_TIMESTAMP || git(['show','-s','--format=%cI','HEAD']) || fallbackTime;
const buildTimestamp = timestamp && Number.isFinite(Date.parse(timestamp)) ? timestamp : new Date().toISOString();
const value = {gitSha,sourceIdentity:gitSha?'known':'unknown',buildTimestamp};
if (!gitSha) { console.error('FATAL: Build provenance missing or invalid. Missing .git directory, BUILD_GIT_SHA env var, or build-provenance.json at root.'); process.exit(1); }
fs.mkdirSync(path.dirname(process.env.PROVENANCE_FILE),{recursive:true});
fs.writeFileSync(process.env.PROVENANCE_FILE,JSON.stringify(value,null,2)+'\n');
console.log(`Generated provenance: source=${value.sourceIdentity}, sha=${gitSha || 'unknown'}`);
JS

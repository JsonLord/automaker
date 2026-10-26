import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyContext } from '../release-identity.mjs';
const exporter = path.resolve('scripts/export-hf-deployment.mjs');
const generator = path.resolve('scripts/generate-provenance.sh');
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'release-test-'));
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: source,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'user.name', 'Fixture');
  for (const f of [
    'Dockerfile',
    'entrypoint.sh',
    'update_settings.py',
    'package.json',
    'package-lock.json',
    'scripts/argus_runtime_bridge.py',
    'apps/server/package.json',
    'apps/ui/package.json',
    'libs/types/package.json',
  ]) {
    await fs.mkdir(path.dirname(path.join(source, f)), { recursive: true });
    await fs.writeFile(path.join(source, f), 'fixture\n');
  }
  git('add', '.');
  git('commit', '-m', 'reviewed fixture');
  const sha = git('rev-parse', 'HEAD');
  const archive = path.join(root, 'source.tar');
  execFileSync(process.execPath, [exporter, archive], { cwd: source });
  const context = path.join(root, 'context');
  await fs.mkdir(context);
  execFileSync('tar', ['-xf', archive, '-C', context]);
  return {
    root,
    source,
    sha,
    archive,
    context,
    manifest: JSON.parse(await fs.readFile(path.join(context, 'release-source.json'), 'utf8')),
  };
}
test('clean git archive reproducibly includes commit-bound provenance and survives without .git', async () => {
  const f = await fixture();
  try {
    const again = path.join(f.root, 'again.tar');
    execFileSync(process.execPath, [exporter, again], { cwd: f.source });
    assert.deepEqual(await fs.readFile(again), await fs.readFile(f.archive));
    assert.equal(verifyContext(f.context, f.manifest, f.sha).gitSha, f.sha);
    const output = path.join(f.root, 'identity.json');
    execFileSync('sh', [generator], {
      cwd: f.context,
      env: {
        ...process.env,
        BUILD_GIT_SHA: f.sha,
        BUILD_TIMESTAMP: f.manifest.buildTimestamp,
        PROVENANCE_FILE: output,
      },
    });
    assert.equal(JSON.parse(await fs.readFile(output, 'utf8')).gitSha, f.sha);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
for (const value of [
  'missing',
  'zero',
  'malformed',
  'wrong SHA',
  'wrong commit',
  'wrong content',
  'wrong tree',
  'wrong timestamp',
  'extra content',
])
  test(`rejects ${value}`, async () => {
    const f = await fixture();
    try {
      if (value === 'missing') await fs.unlink(path.join(f.context, 'release-source.json'));
      if (value === 'zero') f.manifest.sourceSha = '0'.repeat(40);
      if (value === 'malformed') f.manifest.sourceSha = 'invalid';
      if (value === 'wrong SHA') f.manifest.sourceSha = 'a'.repeat(40);
      if (value === 'wrong commit')
        f.manifest.commitBase64 = Buffer.from('unreviewed').toString('base64');
      if (value === 'extra content')
        await fs.writeFile(path.join(f.context, 'injected.ts'), 'unreviewed');
      if (value === 'wrong content')
        await fs.writeFile(path.join(f.context, 'Dockerfile'), 'stale content');
      if (value === 'wrong tree') f.manifest.files[0].oid = 'b'.repeat(40);
      if (value === 'wrong timestamp') f.manifest.buildTimestamp = '2020-01-01T00:00:00.000Z';
      if (value !== 'missing')
        await fs.writeFile(path.join(f.context, 'release-source.json'), JSON.stringify(f.manifest));
      assert.throws(() =>
        execFileSync('sh', [generator], {
          cwd: f.context,
          env: {
            ...process.env,
            BUILD_GIT_SHA: f.sha,
            BUILD_TIMESTAMP: '',
            PROVENANCE_FILE: path.join(f.root, 'out.json'),
          },
          stdio: 'pipe',
        })
      );
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });
test('rejects a stale expected SHA even when the manifest and context agree', async () => {
  const f = await fixture();
  try {
    assert.throws(() => verifyContext(f.context, f.manifest, 'c'.repeat(40)), /SOURCE_MISMATCH/);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

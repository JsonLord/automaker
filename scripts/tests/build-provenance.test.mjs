import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const script = path.resolve('scripts/generate-provenance.sh');
for (const [name, source, expected] of [
  ['missing source', '', null],
  ['zero placeholder', '0'.repeat(40), null],
  ['real source', 'A'.repeat(40), 'a'.repeat(40)],
]) {
  test(`provenance remains truthful and usable with ${name}`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mode-provenance-'));
    try {
      const output = path.join(dir, 'build-provenance.json');
      execFileSync('sh', [script], {
        cwd: dir,
        env: {
          ...process.env,
          BUILD_GIT_SHA: source,
          BUILD_TIMESTAMP: 'malformed"timestamp',
          PROVENANCE_FILE: output,
        },
      });
      const identity = JSON.parse(await readFile(output, 'utf8'));
      assert.equal(identity.gitSha, expected);
      assert.equal(identity.sourceIdentity, expected ? 'known' : 'unknown');
      assert.ok(Number.isFinite(Date.parse(identity.buildTimestamp)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

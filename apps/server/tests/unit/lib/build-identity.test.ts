import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBuildIdentity } from '../../../src/lib/build-identity.js';
import fs from 'fs/promises';

afterEach(() => vi.unstubAllEnvs());

describe('build-identity', () => {
  it('reads from build-provenance.json when valid', async () => {
    vi.spyOn(fs, 'readFile').mockResolvedValueOnce(
      JSON.stringify({
        gitSha: 'a'.repeat(40),
        buildTimestamp: '2026-10-15T00:00:00Z',
      })
    );

    const identity = await readBuildIdentity(async () => '1.18.35');

    expect(identity.gitSha).toBe('a'.repeat(40));
    expect(identity.buildTimestamp).toBe('2026-10-15T00:00:00Z');
  });

  it('reports the forty-zero fallback as unknown provenance without rejecting startup', async () => {
    vi.spyOn(fs, 'readFile').mockResolvedValueOnce(
      JSON.stringify({ gitSha: '0'.repeat(40), buildTimestamp: '2026-10-19T00:00:00Z' })
    );
    expect(await readBuildIdentity(async () => '1.18.35')).toMatchObject({
      gitSha: null,
      sourceIdentity: 'unknown',
      buildTimestamp: '2026-10-19T00:00:00Z',
    });
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(new Error('ENOENT'));
    vi.stubEnv('BUILD_GIT_SHA', '0'.repeat(40));
    expect(await readBuildIdentity(async () => '1.18.35')).toMatchObject({
      gitSha: null,
      sourceIdentity: 'unknown',
    });
  });

  it('falls back to process.env and rejects invalid SHAs', async () => {
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(new Error('ENOENT'));
    vi.stubEnv('BUILD_GIT_SHA', 'invalid-sha');
    vi.stubEnv('BUILD_TIMESTAMP', 'invalid-date');

    const identity = await readBuildIdentity(async () => '1.18.35');

    expect(identity.gitSha).toBeNull();
    expect(identity.buildTimestamp).toBeNull();
  });
});

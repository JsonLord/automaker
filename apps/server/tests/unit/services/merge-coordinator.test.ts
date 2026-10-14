import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import { GitHubMergeCoordinator } from '../../../src/services/argus/merge-coordinator.js';
const base = 'b'.repeat(40),
  head = 'a'.repeat(40),
  merged = 'd'.repeat(40);
function fixture() {
  let currentBase = base,
    strict = true,
    admins = true,
    state = 'success';
  const refs = new Map<string, string>(),
    tags = new Map<string, any>();
  const pr = {
    number: 7,
    headSha: head,
    baseSha: base,
    baseBranch: 'main',
    mergeCommitSha: merged,
  };
  const api = vi.fn(async (args: string[]) => {
    const uri = args.find((a) => a.startsWith('repos/'))!;
    const method = args[args.indexOf('--method') + 1];
    const field = (name: string) =>
      args.find((a) => a.startsWith(name + '='))?.slice(name.length + 1);
    if (uri.includes('/files?')) return [];
    if (uri.includes('/protection'))
      return {
        enforce_admins: { enabled: admins },
        required_status_checks: { strict, contexts: ['integration'] },
      };
    if (uri.includes('/git/commits/')) return { parents: [{ sha: currentBase }, { sha: head }] };
    if (uri.endsWith('/git/tags') && method === 'POST') {
      const sha = crypto.createHash('sha256').update(field('message')!).digest('hex');
      tags.set(sha, { message: field('message') });
      return { sha };
    }
    if (uri.includes('/git/tags/')) return tags.get(uri.split('/').at(-1)!);
    if (uri.endsWith('/git/refs') && method === 'POST') {
      const ref = field('ref')!.replace(/^refs\//, '');
      if (refs.has(ref)) throw new Error('HTTP 422');
      refs.set(ref, field('sha')!);
      return {};
    }
    if (uri.includes('/git/refs/') && method === 'DELETE') {
      refs.delete(uri.split('/git/refs/')[1]);
      return {};
    }
    if (uri.includes('/git/ref/heads/')) return { object: { sha: currentBase } };
    if (uri.includes('/git/ref/')) {
      const sha = refs.get(uri.split('/git/ref/')[1]);
      if (!sha) throw new Error('HTTP 404');
      return { object: { sha } };
    }
    throw new Error('Unexpected mock API operation');
  });
  const github = {
    api,
    getPullRequest: vi.fn(async () => pr),
    observe: vi.fn(async (_: string, sha: string) => ({
      headSha: sha,
      state,
      observedAt: new Date().toISOString(),
    })),
  };
  const task = {
    repository: 'o/r',
    baseBranch: 'main',
    prNumber: 7,
    prHeadSha: head,
    ciHeadSha: head,
    reviewedHeadSha: head,
  } as any;
  return {
    task,
    pr,
    github,
    refs,
    tags,
    coordinator: new GitHubMergeCoordinator(github as any),
    advance: () => (currentBase = 'c'.repeat(40)),
    strict: (value: boolean) => (strict = value),
    admins: (value: boolean) => (admins = value),
    ci: (value: string) => (state = value),
  };
}
afterEach(() => vi.unstubAllEnvs());
describe('repository merge coordination', () => {
  it('lets only one of two independent server instances acquire ownership', async () => {
    const f = fixture();
    const one = f.coordinator.prepare(f.task),
      two = new GitHubMergeCoordinator(f.github as any).prepare({ ...f.task });
    const outcomes = await Promise.allSettled([
      f.coordinator.acquire(one),
      f.coordinator.acquire(two),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(f.refs.size).toBe(1);
    const winner = outcomes[0].status === 'fulfilled' ? one : two;
    await f.coordinator.release(winner);
    expect(f.refs.size).toBe(0);
  });
  it('proves exact current-base integration and strict protections before allowing merge', async () => {
    const f = fixture(),
      lease = f.coordinator.prepare(f.task);
    await f.coordinator.acquire(lease);
    await f.coordinator.assertCurrentBase(f.task, f.pr as any, lease);
    expect(f.task.integrationEvidence).toMatchObject({
      headSha: head,
      baseSha: base,
      mergeSha: merged,
      verdict: 'VERIFIED',
    });
    f.advance();
    await expect(f.coordinator.assertCurrentBase(f.task, f.pr as any, lease)).rejects.toThrow(
      'BASE_ADVANCED'
    );
  });
  it('fails closed on missing base verification and admin bypass protections', async () => {
    const f = fixture(),
      lease = f.coordinator.prepare(f.task);
    await f.coordinator.acquire(lease);
    await expect(
      f.coordinator.assertCurrentBase(f.task, { ...f.pr, mergeCommitSha: null } as any, lease)
    ).rejects.toThrow('VERIFICATION_UNAVAILABLE');
    f.strict(false);
    await expect(f.coordinator.assertCurrentBase(f.task, f.pr as any, lease)).rejects.toThrow(
      'PROTECTION_REQUIRED'
    );
    f.strict(true);
    f.admins(false);
    await expect(f.coordinator.assertCurrentBase(f.task, f.pr as any, lease)).rejects.toThrow(
      'PROTECTION_REQUIRED'
    );
    f.admins(true);
    f.ci('pending');
    await expect(f.coordinator.assertCurrentBase(f.task, f.pr as any, lease)).rejects.toThrow(
      'VERIFICATION_UNAVAILABLE'
    );
  });
  it("recovers its persisted lease after restart and never steals someone else's expired lease", async () => {
    const f = fixture(),
      lease = f.coordinator.prepare(f.task);
    await f.coordinator.acquire(lease);
    const restart = new GitHubMergeCoordinator(f.github as any);
    await restart.acquire(structuredClone(lease));
    await expect(
      restart.acquire({ ...lease, owner: 'other-owner', expiresAt: '2000-01-01T00:00:00Z' })
    ).rejects.toThrow('LEASE_BUSY');
    const expired = new GitHubMergeCoordinator(
      f.github as any,
      () => Date.parse(lease.expiresAt) + 1
    );
    await expect(expired.acquire(lease)).rejects.toThrow('LEASE_EXPIRED');
    expect(f.refs.size).toBe(1);
  });
  it('does not release an ownership token replaced outside the cooperating protocol', async () => {
    const f = fixture(),
      lease = f.coordinator.prepare(f.task);
    await f.coordinator.acquire(lease);
    f.refs.set(lease.reference, 'e'.repeat(40));
    await expect(f.coordinator.release(lease)).rejects.toThrow('LEASE_LOST');
    expect(f.refs.size).toBe(1);
  });
  it('rejects stale review and required Loki evidence for the exact integration pair', async () => {
    const f = fixture(),
      lease = f.coordinator.prepare(f.task);
    await f.coordinator.acquire(lease);
    f.task.reviewedHeadSha = 'f'.repeat(40);
    await expect(f.coordinator.assertCurrentBase(f.task, f.pr as any, lease)).rejects.toThrow(
      'STALE_HEAD'
    );
    f.task.reviewedHeadSha = head;
    vi.stubEnv('ARGUS_LOKI_REQUIRED_FOR_MERGE', 'true');
    await expect(f.coordinator.assertCurrentBase(f.task, f.pr as any, lease)).rejects.toThrow(
      'LOKI_EVIDENCE_REQUIRED'
    );
  });
});

import crypto from 'crypto';
import type { ArgusTaskState } from './types.js';
import type { GitHubCiObserver, GitHubPullRequest } from './github-ci-observer.js';

export interface RepositoryMergeLease {
  owner: string;
  reference: string;
  tagSha: string | null;
  expiresAt: string;
  repository: string;
  baseBranch: string;
}
export interface MergeCoordinator {
  prepare(task: ArgusTaskState): RepositoryMergeLease;
  acquire(lease: RepositoryMergeLease): Promise<void>;
  assertCurrentBase(
    task: ArgusTaskState,
    pr: GitHubPullRequest,
    lease: RepositoryMergeLease
  ): Promise<void>;
  release(lease: RepositoryMergeLease): Promise<void>;
}

/** Atomic GitHub ref creation coordinates cooperating instances across project volumes.
 * Unknown/expired leases are not stolen. Strict branch protection closes the last base-advance race. */
export class GitHubMergeCoordinator implements MergeCoordinator {
  constructor(
    private github: GitHubCiObserver,
    private now = () => Date.now()
  ) {}
  prepare(task: ArgusTaskState): RepositoryMergeLease {
    if (task.mergeLease) return task.mergeLease;
    const hash = crypto
      .createHash('sha256')
      .update(`${task.repository?.toLowerCase()}`)
      .digest('hex')
      .slice(0, 32);
    return {
      owner: crypto.randomUUID(),
      reference: `tags/automaker-merge-lease-${hash}`,
      tagSha: null,
      expiresAt: new Date(this.now() + 600000).toISOString(),
      repository: task.repository!,
      baseBranch: task.baseBranch!,
    };
  }
  private async reference(lease: RepositoryMergeLease) {
    try {
      return await this.github.api(['api', `repos/${lease.repository}/git/ref/${lease.reference}`]);
    } catch (error) {
      if (/\b404\b/.test((error as Error).message)) return undefined;
      throw error;
    }
  }
  async acquire(lease: RepositoryMergeLease) {
    const current = await this.reference(lease);
    if (current) {
      const tag = await this.github.api([
        'api',
        `repos/${lease.repository}/git/tags/${current.object.sha}`,
      ]);
      let owner: string | undefined;
      try {
        owner = JSON.parse(tag.message).owner;
      } catch {
        /* unknown ownership */
      }
      if (owner !== lease.owner) throw new Error('MERGE_REPOSITORY_LEASE_BUSY');
      lease.tagSha = current.object.sha;
      if (Date.parse(lease.expiresAt) <= this.now())
        throw new Error('MERGE_REPOSITORY_LEASE_EXPIRED');
      return;
    }
    if (lease.tagSha) throw new Error('MERGE_REPOSITORY_LEASE_LOST');
    const base = await this.github.api([
      'api',
      `repos/${lease.repository}/git/ref/heads/${encodeURIComponent(lease.baseBranch)}`,
    ]);
    const tag = await this.github.api([
      'api',
      '--method',
      'POST',
      `repos/${lease.repository}/git/tags`,
      '-f',
      `tag=${lease.reference.slice(5)}`,
      '-f',
      `message=${JSON.stringify({ owner: lease.owner, expiresAt: lease.expiresAt })}`,
      '-f',
      `object=${base.object.sha}`,
      '-f',
      'type=commit',
    ]);
    try {
      await this.github.api([
        'api',
        '--method',
        'POST',
        `repos/${lease.repository}/git/refs`,
        '-f',
        `ref=refs/${lease.reference}`,
        '-f',
        `sha=${tag.sha}`,
      ]);
      lease.tagSha = tag.sha;
    } catch {
      throw new Error('MERGE_REPOSITORY_LEASE_BUSY');
    }
  }
  async assertCurrentBase(
    task: ArgusTaskState,
    pr: GitHubPullRequest,
    lease: RepositoryMergeLease
  ) {
    const owned = await this.reference(lease);
    if (
      !lease.tagSha ||
      owned?.object.sha !== lease.tagSha ||
      Date.parse(lease.expiresAt) <= this.now()
    )
      throw new Error('MERGE_REPOSITORY_LEASE_LOST');
    const base = await this.github.api([
      'api',
      `repos/${lease.repository}/git/ref/heads/${encodeURIComponent(lease.baseBranch)}`,
    ]);
    if (base.object.sha !== pr.baseSha) throw new Error('MERGE_BASE_ADVANCED');
    for (let page = 1; page <= 5; page++) {
      const files = await this.github.api([
        'api',
        `repos/${lease.repository}/pulls/${task.prNumber}/files?per_page=100&page=${page}`,
      ]);
      if (!Array.isArray(files)) throw new Error('MERGE_CHANGED_FILES_UNAVAILABLE');
      if (
        files.some((file: { filename: string; previous_filename?: string }) =>
          [file.filename, file.previous_filename || ''].some(
            (name) => name === 'ARGUS.md' || name === '.automaker' || name.startsWith('.automaker/')
          )
        )
      )
        throw new Error('MERGE_PROTECTED_ARGUS_STATE_CHANGED');
      if (files.length < 100) break;
      if (page === 5) throw new Error('MERGE_CHANGED_FILES_LIMIT');
    }
    const protection = await this.github.api([
      'api',
      `repos/${lease.repository}/branches/${encodeURIComponent(lease.baseBranch)}/protection`,
    ]);
    if (
      protection.enforce_admins?.enabled !== true ||
      protection.required_status_checks?.strict !== true ||
      (!protection.required_status_checks.contexts?.length &&
        !protection.required_status_checks.checks?.length)
    )
      throw new Error('MERGE_STRICT_BASE_PROTECTION_REQUIRED');
    if (!pr.mergeCommitSha) throw new Error('MERGE_CURRENT_BASE_VERIFICATION_UNAVAILABLE');
    const commit = await this.github.api([
      'api',
      `repos/${lease.repository}/git/commits/${pr.mergeCommitSha}`,
    ]);
    const parents = (commit.parents || []).map((p: { sha: string }) => p.sha);
    if (parents.length !== 2 || !parents.includes(pr.baseSha) || !parents.includes(pr.headSha))
      throw new Error('MERGE_INTEGRATION_COMMIT_STALE');
    const ci = await this.github.observe(lease.repository, pr.mergeCommitSha);
    if (ci.headSha !== pr.mergeCommitSha || ci.state !== 'success')
      throw new Error('MERGE_CURRENT_BASE_VERIFICATION_UNAVAILABLE');
    if (
      task.prHeadSha !== pr.headSha ||
      task.ciHeadSha !== pr.headSha ||
      task.reviewedHeadSha !== pr.headSha
    )
      throw new Error('MERGE_GATE_STALE_HEAD');
    if (
      process.env.ARGUS_LOKI_REQUIRED_FOR_MERGE === 'true' &&
      (task.lokiEvidence?.verdict !== 'VERIFIED' ||
        task.lokiEvidence.headSha !== pr.headSha ||
        task.lokiEvidence.baseSha !== pr.baseSha)
    )
      throw new Error('MERGE_LOKI_EVIDENCE_REQUIRED');
    const finalBase = await this.github.api([
      'api',
      `repos/${lease.repository}/git/ref/heads/${encodeURIComponent(lease.baseBranch)}`,
    ]);
    const finalPr = await this.github.getPullRequest(lease.repository, task.prNumber!);
    if (finalBase.object.sha !== pr.baseSha) throw new Error('MERGE_BASE_ADVANCED');
    if (finalPr.headSha !== pr.headSha) throw new Error('MERGE_GATE_STALE_HEAD');
    task.integrationEvidence = {
      headSha: pr.headSha,
      baseSha: pr.baseSha,
      mergeSha: pr.mergeCommitSha,
      verdict: 'VERIFIED',
      observedAt: ci.observedAt,
    };
  }
  async release(lease: RepositoryMergeLease) {
    const ref = await this.reference(lease);
    if (!ref) return;
    if (ref.object.sha !== lease.tagSha) throw new Error('MERGE_REPOSITORY_LEASE_LOST');
    await this.github.api([
      'api',
      '--method',
      'DELETE',
      `repos/${lease.repository}/git/refs/${lease.reference}`,
    ]);
  }
}

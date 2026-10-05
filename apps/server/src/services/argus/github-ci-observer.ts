import { spawnProcess } from '@automaker/platform';
import type { CiFailureSummary, CiState } from './types.js';

export interface GitHubPullRequest {
  number: number;
  state: string;
  url: string;
  repository: string;
  baseBranch: string;
  baseSha: string;
  headBranch: string;
  headSha: string;
  merged: boolean;
  mergeCommitSha: string | null;
}
export interface CiObservation {
  headSha: string;
  state: CiState;
  observedAt: string;
  runIds: string[];
  failures: CiFailureSummary[];
}
export type GhRunner = (args: string[]) => Promise<string>;

const MAX_RUNS = 20;
const MAX_JOBS = 20;
const MAX_FAILURES = 10;
const MAX_EXCERPT = 2_000;

export class GitHubCiObserver {
  constructor(
    private readonly runner: GhRunner = GitHubCiObserver.defaultRunner,
    private readonly secrets: string[] = [
      process.env.GITHUB_PAT,
      process.env.JULES_API_KEY,
      process.env.COMPATIBLE_API_KEY,
    ].filter((value): value is string => Boolean(value))
  ) {}

  static async defaultRunner(args: string[]) {
    const env = Object.fromEntries(
      [
        ['PATH', process.env.PATH],
        ['HOME', process.env.HOME],
        ['GH_TOKEN', process.env.GITHUB_PAT],
      ].filter((entry): entry is [string, string] => Boolean(entry[1]))
    );
    const result = await spawnProcess({ command: 'gh', args, env, cwd: process.cwd() });
    if (result.exitCode !== 0) throw new Error('GITHUB_OBSERVATION_FAILED');
    return result.stdout;
  }

  async getPullRequest(repository: string, number: number): Promise<GitHubPullRequest> {
    const value = JSON.parse(
      await this.runner(['api', `repos/${repository}/pulls/${number}`])
    ) as Record<string, any>;
    return {
      number: value.number,
      state: String(value.state).toUpperCase(),
      url: value.html_url,
      repository: `${value.base.repo.owner.login}/${value.base.repo.name}`.toLowerCase(),
      baseBranch: value.base.ref,
      baseSha: value.base.sha,
      headBranch: value.head.ref,
      headSha: value.head.sha,
      merged: Boolean(value.merged),
      mergeCommitSha: value.merge_commit_sha || null,
    };
  }

  async mergePullRequest(repository: string, number: number, expectedHeadSha: string) {
    return JSON.parse(
      await this.runner([
        'api',
        '--method',
        'PUT',
        `repos/${repository}/pulls/${number}/merge`,
        '-f',
        `sha=${expectedHeadSha}`,
        '-f',
        'merge_method=merge',
      ])
    ) as { merged: boolean; sha?: string; message?: string };
  }

  async getPullRequestDiff(repository: string, number: number): Promise<string> {
    return (
      await this.runner([
        'api',
        '-H',
        'Accept: application/vnd.github.v3.diff',
        `repos/${repository}/pulls/${number}`,
      ])
    ).slice(0, 50_000);
  }

  async observe(repository: string, headSha: string): Promise<CiObservation> {
    const [checksValue, runsValue] = await Promise.all([
      this.json(['api', `repos/${repository}/commits/${headSha}/check-runs`]),
      this.json([
        'api',
        `repos/${repository}/actions/runs?head_sha=${headSha}&per_page=${MAX_RUNS}`,
      ]),
    ]);
    const checks = (checksValue.check_runs || []).filter(
      (check: any) => !check.head_sha || check.head_sha === headSha
    );
    const runs = (runsValue.workflow_runs || [])
      .filter((run: any) => run.head_sha === headSha)
      .slice(0, MAX_RUNS);
    if (!checks.length && !runs.length) return this.result(headSha, 'not-configured', [], []);
    const conclusions = [...checks, ...runs].map((item: any) => ({
      status: item.status,
      conclusion: item.conclusion,
    }));
    let state: CiState = 'success';
    if (conclusions.some((item) => item.status !== 'completed' && item.status !== 'COMPLETED'))
      state = 'pending';
    else if (
      conclusions.some((item) =>
        ['failure', 'timed_out', 'action_required'].includes(item.conclusion)
      )
    )
      state = 'failure';
    else if (conclusions.some((item) => item.conclusion === 'cancelled')) state = 'cancelled';
    else if (conclusions.some((item) => item.conclusion !== 'success')) state = 'unknown';
    const failures = state === 'failure' ? await this.failureEvidence(repository, runs) : [];
    return this.result(
      headSha,
      state,
      runs.map((run: any) => String(run.id)),
      failures
    );
  }

  private async failureEvidence(repository: string, runs: any[]): Promise<CiFailureSummary[]> {
    const failures: CiFailureSummary[] = [];
    for (const run of runs.filter((item) => item.conclusion === 'failure').slice(0, MAX_RUNS)) {
      const jobs =
        (
          await this.json([
            'api',
            `repos/${repository}/actions/runs/${run.id}/jobs?per_page=${MAX_JOBS}`,
          ])
        ).jobs || [];
      for (const job of jobs
        .filter((item: any) => item.conclusion === 'failure')
        .slice(0, MAX_JOBS)) {
        const step = (job.steps || []).find((item: any) => item.conclusion === 'failure');
        let excerpt = '';
        try {
          excerpt = await this.runner(['api', `repos/${repository}/actions/jobs/${job.id}/logs`]);
        } catch {
          excerpt = 'Log excerpt unavailable.';
        }
        failures.push({
          workflowName: run.name || 'workflow',
          workflowRunId: String(run.id),
          jobName: job.name || 'job',
          jobId: String(job.id),
          failedStep: step?.name || 'unknown',
          conclusion: job.conclusion,
          excerpt: this.redact(excerpt).slice(-MAX_EXCERPT),
          observedAt: new Date().toISOString(),
        });
        if (failures.length >= MAX_FAILURES) return failures;
      }
    }
    return failures;
  }

  private redact(value: string) {
    return this.secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), value);
  }
  private async json(args: string[]): Promise<Record<string, any>> {
    return JSON.parse(await this.runner(args));
  }
  private result(headSha: string, state: CiState, runIds: string[], failures: CiFailureSummary[]) {
    return { headSha, state, runIds, failures, observedAt: new Date().toISOString() };
  }
}

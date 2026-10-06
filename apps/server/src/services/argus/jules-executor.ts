import type { FeatureLoader } from '../feature-loader.js';
import { saveArgusState } from './project-lifecycle.js';
import {
  captureGitDispatchContext,
  verifyPullRequest,
  type GitDispatchContext,
} from './git-context.js';
import { JulesClient, JulesError, normalizeJulesActivity } from './jules-client.js';
import type { ArgusService, ArgusTaskState, DeveloperExecutor } from './types.js';
import crypto from 'crypto';

const TERMINAL = new Set(['COMPLETED', 'FAILED']);
const JULES_OWNED_PHASES = new Set<ArgusTaskState['phase']>([
  'awaiting-executor',
  'jules-running',
  'pr-open',
  'jules-repair',
  'senior-guided-repair',
]);

export function isJulesOwnedPhase(phase: ArgusTaskState['phase']): boolean {
  return JULES_OWNED_PHASES.has(phase);
}

export class JulesDeveloperAdapter implements DeveloperExecutor {
  readonly id = 'jules' as const;
  private monitors = new Map<string, Promise<void>>();
  constructor(
    private readonly client: JulesClient,
    private readonly argus: ArgusService,
    private readonly features: FeatureLoader,
    private readonly options: {
      captureGit?: (path: string) => Promise<GitDispatchContext>;
      verifyPr?: typeof verifyPullRequest;
      autoMonitor?: boolean;
      sleep?: (ms: number) => Promise<void>;
      onPullRequest?: (projectPath: string) => Promise<void>;
    } = {}
  ) {}

  async dispatch(task: ArgusTaskState, projectPath: string): Promise<void> {
    if (task.julesSessionId) return this.reconcile(task, projectPath);
    this.acquireLease(task);
    try {
      const git = await (this.options.captureGit || captureGitDispatchContext)(projectPath);
      task.baseBranch = git.baseBranch;
      task.baseRemoteSha = git.baseRemoteSha;
      task.repository = git.repository;
      const source = await this.client.findRepositorySource(git.repository);
      task.julesSourceId = source.name;
      const marker =
        task.dispatchIntent?.deterministicMarker ||
        `automaker:${crypto.createHash('sha256').update(`${task.taskId}:${task.sourceSpecRevision}:1`).digest('hex').slice(0, 20)}`;
      task.dispatchIntent ||= {
        taskId: task.taskId,
        dispatchAttemptId: crypto.randomUUID(),
        source: source.name,
        repository: git.repository,
        baseBranch: git.baseBranch,
        baseRemoteSha: git.baseRemoteSha,
        deterministicMarker: marker,
        startedAt: new Date().toISOString(),
        remoteOutcome: 'unknown',
      };
      await this.persist(projectPath, task);
      const matches = (await this.client.listSessions()).filter(
        (candidate) =>
          candidate.title?.includes(marker) && candidate.sourceContext?.source === source.name
      );
      if (matches.length > 1)
        throw new JulesError(
          'JULES_DISPATCH_AMBIGUOUS',
          'Multiple Jules sessions match dispatch intent',
          false,
          true
        );
      const recovered = matches[0];
      const session =
        recovered ||
        (await this.client.createTaskSession({
          prompt: `${this.prompt(task, git)}\n\nDispatch marker: ${marker}`,
          title: `${task.title} [${marker}]`,
          source: source.name,
          branch: git.baseBranch,
        }));
      // Crash invariant: persist the remote identity before starting any poll or returning control.
      task.julesSessionId = session.id;
      task.julesState = session.state;
      task.phase = 'jules-running';
      task.dispatchIntent.remoteOutcome = 'created';
      task.lastArgusEvent = 'JULES_CREATED';
      await this.persist(projectPath, task);
      if (this.options.autoMonitor !== false) this.startMonitor(task, projectPath);
    } catch (error) {
      task.phase = 'blocked';
      task.lease = null;
      task.blockedReason =
        error instanceof JulesError
          ? error.code
          : String((error as Error).message || error).split(':')[0];
      task.lastArgusEvent = task.blockedReason;
      await this.persist(projectPath, task);
    }
  }
  async reconcile(task: ArgusTaskState, projectPath: string): Promise<void> {
    if (!task.julesSessionId) return;
    const ownsPhase = isJulesOwnedPhase(task.phase);
    const { session, activities, pullRequest } = await this.client.reconcileSession(
      task.julesSessionId
    );
    task.julesState = session.state;
    if (!ownsPhase) {
      // Downstream CI/review/merge orchestration owns both the phase and exact-head
      // metadata. A late Jules response must never move that durable workflow backwards.
      await this.persist(projectPath, task);
      return;
    }
    if (task.lease?.executor === 'jules') task.lease.heartbeatAt = new Date().toISOString();
    task.lastArgusEvent = activities.length
      ? normalizeJulesActivity(activities.at(-1)!)
      : `JULES_${session.state}`;
    if (pullRequest) await this.recordPullRequest(task, projectPath, pullRequest.url);
    else if (session.state === 'FAILED') {
      task.phase = 'blocked';
      task.blockedReason = 'JULES_REMOTE_FAILED';
      task.lease = null;
    } else if (session.state === 'COMPLETED') {
      task.phase = 'blocked';
      task.blockedReason = 'JULES_PR_MISSING';
      task.lease = null;
    } else task.phase = 'jules-running';
    await this.persist(projectPath, task);
    if (task.phase === 'pr-open') await this.options.onPullRequest?.(projectPath);
  }
  private startMonitor(task: ArgusTaskState, projectPath: string) {
    if (this.monitors.has(task.taskId)) return;
    const promise = this.monitor(task, projectPath).finally(() =>
      this.monitors.delete(task.taskId)
    );
    this.monitors.set(task.taskId, promise);
  }
  private async monitor(task: ArgusTaskState, projectPath: string) {
    const delays = [2_000, 3_000, 5_000, 8_000, 13_000, 21_000, 30_000];
    const sleep =
      this.options.sleep || ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; ; attempt++) {
      await sleep(delays[Math.min(attempt, delays.length - 1)]);
      try {
        await this.reconcile(task, projectPath);
      } catch (error) {
        if (!(error instanceof JulesError) || !error.retryable) throw error;
        task.lastArgusEvent = 'JULES_RECONCILE_RETRY';
        await this.persist(projectPath, task);
        continue;
      }
      if (task.julesState && TERMINAL.has(task.julesState)) return;
    }
  }
  private async recordPullRequest(task: ArgusTaskState, projectPath: string, url: string) {
    if (!task.repository || !task.baseBranch)
      throw new Error('GITHUB_PR_LOOKUP_FAILED: dispatch identity missing');
    const verified = await (this.options.verifyPr || verifyPullRequest)(url, projectPath, {
      repository: task.repository,
      baseBranch: task.baseBranch,
      branch: task.julesBranch || undefined,
    });
    task.prNumber = verified.number;
    task.prUrl = verified.url;
    const previousHead = task.prHeadSha;
    if (!previousHead) task.prHeadSha = verified.headSha;
    task.julesBranch = verified.branch;
    if (
      (task.phase === 'jules-repair' || task.phase === 'senior-guided-repair') &&
      previousHead === verified.headSha
    )
      return;
    task.phase = 'pr-open';
    task.lastArgusEvent = 'JULES_PR_CREATED';
    task.lease = null;
  }
  private acquireLease(task: ArgusTaskState) {
    if (task.lease && task.lease.executor !== 'jules')
      throw new JulesError(
        'TASK_LEASE_CONFLICT',
        'Task has another implementation owner',
        false,
        true
      );
    const now = new Date().toISOString();
    task.lease = {
      taskId: task.taskId,
      executor: 'jules',
      acquiredAt: task.lease?.acquiredAt || now,
      heartbeatAt: now,
    };
  }
  private async persist(projectPath: string, task: ArgusTaskState) {
    const state = await this.argus.getStatus(projectPath);
    if (!state) throw new Error('Argus project missing');
    state.activeTask = task;
    state.phase = task.phase;
    state.latestStatus = task.lastArgusEvent;
    await saveArgusState(projectPath, state);
    await this.features.update(projectPath, task.featureId, {
      status: task.phase === 'blocked' ? 'failed' : task.phase === 'pr-open' ? 'review' : 'running',
      argus: { ...task },
    });
  }
  private prompt(task: ArgusTaskState, git: GitDispatchContext) {
    return [
      `Objective: ${task.objective}`,
      `Repository: ${git.repository}`,
      `Starting branch: ${git.baseBranch}`,
      `Base remote SHA: ${git.baseRemoteSha}`,
      `Description: ${task.description}`,
      `Acceptance criteria:\n- ${task.acceptanceCriteria.join('\n- ')}`,
      `Evidence required:\n- ${task.evidenceRequired.join('\n- ')}`,
      'Respect the repository architecture and ARGUS.md constraints.',
      'Commit the implementation and create a pull request.',
      'Do not deploy, release, or publish anything. Do not modify ARGUS.md.',
    ].join('\n\n');
  }
}

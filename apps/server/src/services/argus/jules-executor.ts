import type { FeatureLoader } from '../feature-loader.js';
import { saveArgusState } from './project-lifecycle.js';
import {
  captureGitDispatchContext,
  verifyPullRequest,
  type GitDispatchContext,
} from './git-context.js';
import { JulesClient, JulesError, normalizeJulesActivity } from './jules-client.js';
import type { ArgusService, ArgusTaskState, DeveloperExecutor } from './types.js';

const TERMINAL = new Set(['COMPLETED', 'FAILED']);
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
    } = {}
  ) {}

  async dispatch(task: ArgusTaskState, projectPath: string): Promise<void> {
    if (task.julesSessionId) return this.reconcile(task, projectPath);
    this.acquireLease(task);
    try {
      const git = await (this.options.captureGit || captureGitDispatchContext)(projectPath);
      task.baseBranch = git.baseBranch;
      task.baseRemoteSha = git.baseRemoteSha;
      const source = await this.client.findRepositorySource(git.repository);
      task.julesSourceId = source.name;
      const session = await this.client.createTaskSession({
        prompt: this.prompt(task, git),
        title: task.title,
        source: source.name,
        branch: git.baseBranch,
      });
      // Crash invariant: persist the remote identity before starting any poll or returning control.
      task.julesSessionId = session.id;
      task.julesState = session.state;
      task.phase = 'jules-running';
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
    const { session, activities, pullRequest } = await this.client.reconcileSession(
      task.julesSessionId
    );
    task.julesState = session.state;
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
    for (let attempt = 0; attempt < 120; attempt++) {
      await sleep(delays[Math.min(attempt, delays.length - 1)]);
      await this.reconcile(task, projectPath);
      if (task.julesState && TERMINAL.has(task.julesState)) return;
    }
    task.phase = 'blocked';
    task.blockedReason = 'JULES_SESSION_TIMEOUT';
    task.lease = null;
    await this.persist(projectPath, task);
  }
  private async recordPullRequest(task: ArgusTaskState, projectPath: string, url: string) {
    const verified = await (this.options.verifyPr || verifyPullRequest)(url, projectPath);
    task.prNumber = verified.number;
    task.prUrl = verified.url;
    task.prHeadSha = verified.headSha;
    task.julesBranch = verified.branch;
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

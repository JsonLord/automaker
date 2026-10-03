import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';
import { createLogger } from '@automaker/utils';
import { resolveState, saveArgusState } from './project-lifecycle.js';
import type {
  ArgusBridgeError,
  ArgusManagerDecision,
  ArgusPlannedTask,
  ArgusProjectState,
  ArgusRuntimeHealth,
  ArgusService,
} from './types.js';

const logger = createLogger('ArgusService');
type BridgeResponse = {
  requestId: number;
  ok: boolean;
  result?: unknown;
  error?: ArgusBridgeError;
};
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };
const TIMEOUTS: Record<string, number> = {
  health: 5_000,
  ensure_project: 15_000,
  get_status: 10_000,
  resume_project: 15_000,
  manager_handoff: 180_000,
  planner_next_task: 180_000,
  get_pending_work: 10_000,
  get_recent_events: 10_000,
  shutdown: 5_000,
};

export class ArgusOperationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean
  ) {
    super(message);
  }
}

export class SupervisedArgusService implements ArgusService {
  private child?: ChildProcessWithoutNullStreams;
  private requests = new Map<number, Pending>();
  private sequence = 0;
  private projects = new Map<string, ArgusProjectState>();
  constructor(
    private bridgePath = process.env.ARGUS_BRIDGE_PATH ||
      path.resolve(process.cwd(), 'scripts', 'argus_runtime_bridge.py')
  ) {}

  async start(): Promise<void> {
    if (this.child && !this.child.killed) return;
    const allowed = [
      'PATH',
      'HOME',
      'ARGUS_BIN',
      'ARGUS_BRIDGE_FAKE',
      'ARGUS_WEB_PORT',
      'COMPATIBLE_API_KEY',
    ];
    const env = Object.fromEntries(
      allowed.flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : []))
    );
    this.child = spawn(process.env.ARGUS_PYTHON || 'python3', ['-u', this.bridgePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      let message: BridgeResponse;
      try {
        message = JSON.parse(line) as BridgeResponse;
      } catch {
        logger.warn('Ignored malformed Argus bridge output');
        return;
      }
      const pending = this.requests.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.requests.delete(message.requestId);
      if (message.ok) pending.resolve(message.result);
      else
        pending.reject(
          new ArgusOperationError(
            message.error?.code || 'ARGUS_BRIDGE_ERROR',
            message.error?.message || 'Argus operation failed',
            Boolean(message.error?.retryable)
          )
        );
    });
    this.child.stderr.on('data', (chunk) =>
      logger.warn(`Argus bridge: ${String(chunk).trim().slice(0, 500)}`)
    );
    this.child.on('exit', (code) => {
      this.child = undefined;
      for (const pending of this.requests.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Argus bridge exited'));
      }
      this.requests.clear();
      if (code) logger.error(`Argus bridge exited (${code})`);
    });
    await this.call<ArgusRuntimeHealth>('health');
  }
  async stop() {
    if (!this.child) return;
    const child = this.child;
    try {
      await this.call('shutdown');
    } catch {
      child.kill('SIGTERM');
    }
    this.child = undefined;
  }
  async health() {
    return this.child
      ? this.call<ArgusRuntimeHealth>('health')
      : { running: false, upstreamInstalled: false, error: 'bridge not started' };
  }
  async createOrResolveProject(input: { projectId: string; projectPath: string; model: string }) {
    const state = await resolveState(input.projectId, input.projectPath, input.model);
    this.projects.set(input.projectPath, state);
    await this.call('ensure_project', {
      projectId: state.argusProjectId,
      sessionId: state.argusSessionId,
      projectPath: input.projectPath,
      roles: state.roles,
    });
    return state;
  }
  async resumeProject(projectPath: string) {
    const state = this.requireProject(projectPath);
    await this.call('resume_project', { projectId: state.argusProjectId });
    state.latestStatus = 'Argus project resumed.';
    await saveArgusState(projectPath, state);
    return state;
  }
  async managerHandoff(projectPath: string): Promise<ArgusManagerDecision> {
    const state = this.requireProject(projectPath);
    state.managerStatus = 'running';
    await saveArgusState(projectPath, state);
    const [objective, spec] = await Promise.all([
      fs.readFile(path.join(projectPath, 'ARGUS.md'), 'utf8'),
      fs.readFile(path.join(projectPath, 'spec.md'), 'utf8'),
    ]);
    const result = await this.call<ArgusManagerDecision>('manager_handoff', {
      projectId: state.argusProjectId,
      projectPath,
      objectivePath: 'ARGUS.md',
      specPath: 'spec.md',
      objective,
      spec,
      lifecycle: {
        specRevision: state.specRevision,
        phase: state.phase,
        activeTask: state.activeTask,
      },
    });
    state.managerStatus = result.reason;
    state.latestStatus = `Manager: ${result.reason}`;
    await saveArgusState(projectPath, state);
    return result;
  }
  async plannerNextTask(projectPath: string, decision: ArgusManagerDecision) {
    const state = this.requireProject(projectPath);
    state.plannerStatus = 'running';
    await saveArgusState(projectPath, state);
    const result = await this.call<ArgusPlannedTask | null>('planner_next_task', {
      projectId: state.argusProjectId,
      projectPath,
      managerDecision: decision,
      sourceSpecRevision: state.specRevision,
    });
    state.plannerStatus = result ? `planned ${result.taskId}` : 'no work';
    await saveArgusState(projectPath, state);
    return result;
  }
  getPendingWork(projectPath: string) {
    const state = this.requireProject(projectPath);
    return this.call<ArgusPlannedTask[]>('get_pending_work', { projectId: state.argusProjectId });
  }
  getRecentEvents(projectPath: string) {
    const state = this.requireProject(projectPath);
    return this.call<Array<Record<string, unknown>>>('get_recent_events', {
      projectId: state.argusProjectId,
    });
  }
  async getStatus(projectPath: string) {
    return this.projects.get(projectPath);
  }
  private requireProject(projectPath: string) {
    const state = this.projects.get(projectPath);
    if (!state) throw new Error(`Argus project is not registered: ${projectPath}`);
    return state;
  }
  private call<T = Record<string, unknown>>(
    operation: string,
    params: Record<string, unknown> = {}
  ): Promise<T> {
    if (!this.child) throw new Error('Argus bridge is not running');
    const requestId = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(requestId);
        reject(new ArgusOperationError('ARGUS_OPERATION_TIMEOUT', `${operation} timed out`, true));
      }, TIMEOUTS[operation] || 10_000);
      this.requests.set(requestId, { resolve: (value) => resolve(value as T), reject, timer });
      this.child!.stdin.write(`${JSON.stringify({ requestId, operation, params })}\n`);
    });
  }
}

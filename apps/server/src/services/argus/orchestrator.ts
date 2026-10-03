import type { FeatureLoader } from '../feature-loader.js';
import { saveArgusState } from './project-lifecycle.js';
import type {
  ArgusManagerDecision,
  ArgusPlannedTask,
  ArgusService,
  ArgusTaskState,
} from './types.js';

function taskState(task: ArgusPlannedTask, featureId: string): ArgusTaskState {
  return {
    ...task,
    featureId,
    phase: task.recommendedExecutor === 'blocked' ? 'blocked' : 'awaiting-executor',
    executor:
      task.recommendedExecutor === 'senior'
        ? 'senior'
        : task.recommendedExecutor === 'junior'
          ? 'jules'
          : null,
    julesSessionId: null,
    julesSourceId: null,
    julesState: null,
    julesBranch: null,
    prNumber: null,
    prUrl: null,
    baseBranch: null,
    baseRemoteSha: null,
    prHeadSha: null,
    reviewedHeadSha: null,
    mergedSha: null,
    localSyncedSha: null,
    retryCount: 0,
    lastArgusEvent: 'ARGUS_TASK_PLANNED',
    blockedReason: task.recommendedExecutor === 'blocked' ? task.description : null,
    lease: null,
  };
}

export class ArgusOrchestrator {
  constructor(
    private readonly argus: ArgusService,
    private readonly features: FeatureLoader
  ) {}
  async reconcileProject(projectPath: string): Promise<ArgusTaskState | null> {
    const state = await this.argus.getStatus(projectPath);
    if (!state || state.autonomy !== 'enabled') return null;
    if (state.activeTask) {
      await this.projectCard(projectPath, state.activeTask);
      return state.activeTask;
    }
    const decision = await this.argus.managerHandoff(projectPath);
    this.validateDecision(decision);
    if (!decision.admitted) {
      state.phase = 'blocked';
      state.latestStatus = `Manager deferred: ${decision.reason}`;
      await saveArgusState(projectPath, state);
      return null;
    }
    const planned = await this.argus.plannerNextTask(projectPath, decision);
    if (!planned) {
      state.phase = 'idle';
      await saveArgusState(projectPath, state);
      return null;
    }
    if (/\b(deploy|publish|release)\b/i.test(`${planned.objective} ${planned.description}`))
      planned.recommendedExecutor = 'blocked';
    const featureId = `argus-${planned.taskId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80)}`;
    state.activeTask = taskState(planned, featureId);
    state.phase = state.activeTask.phase;
    state.latestStatus = `Planner created ${planned.taskId}`;
    await saveArgusState(projectPath, state);
    await this.projectCard(projectPath, state.activeTask);
    return state.activeTask;
  }
  async projectCard(projectPath: string, task: ArgusTaskState): Promise<void> {
    const existing = await this.features.get(projectPath, task.featureId);
    const data = {
      id: task.featureId,
      title: task.title,
      category: 'Argus',
      description: task.description,
      status: task.phase === 'blocked' ? 'failed' : 'backlog',
      dependencies: task.dependencies,
      planningMode: 'skip' as const,
      requirePlanApproval: false,
      argus: { ...task },
    };
    if (existing) await this.features.update(projectPath, task.featureId, data);
    else await this.features.create(projectPath, data);
  }
  private validateDecision(decision: ArgusManagerDecision) {
    if (!decision || typeof decision.admitted !== 'boolean' || !decision.reason)
      throw new Error('ARGUS_MANAGER_FAILED: malformed Manager decision');
  }
}

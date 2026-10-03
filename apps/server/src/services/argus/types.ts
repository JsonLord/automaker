export type ArgusRole = 'manager' | 'planner' | 'reviewer' | 'senior-engineer';
export type ArgusPhase =
  | 'idle'
  | 'planning'
  | 'awaiting-executor'
  | 'jules-running'
  | 'pr-open'
  | 'blocked'
  | 'error';
export type RecommendedExecutor = 'junior' | 'senior' | 'review_only' | 'blocked';

export interface ArgusRoleContext {
  role: ArgusRole;
  backend: 'opencode';
  model: string;
  contextId: string;
  readOnly: boolean;
}
export interface ArgusBridgeError {
  code: string;
  message: string;
  retryable: boolean;
}
export interface ArgusManagerDecision {
  admitted: boolean;
  reason: string;
  evidence: string[];
  recommendedExecutor: RecommendedExecutor;
  needsNextSpec: boolean;
}
export interface ArgusPlannedTask {
  taskId: string;
  title: string;
  objective: string;
  description: string;
  acceptanceCriteria: string[];
  evidenceRequired: string[];
  recommendedExecutor: RecommendedExecutor;
  dependencies: string[];
  risk: string;
  sourceSpecRevision: number;
}
export interface ArgusTaskLease {
  taskId: string;
  executor: 'jules' | 'senior';
  acquiredAt: string;
  heartbeatAt: string;
}
export interface ArgusTaskState extends ArgusPlannedTask {
  featureId: string;
  phase: ArgusPhase;
  executor: 'jules' | 'senior' | null;
  julesSessionId: string | null;
  julesSourceId: string | null;
  julesState: string | null;
  julesBranch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  baseBranch: string | null;
  baseRemoteSha: string | null;
  prHeadSha: string | null;
  reviewedHeadSha: string | null;
  mergedSha: string | null;
  localSyncedSha: string | null;
  retryCount: number;
  lastArgusEvent: string;
  blockedReason: string | null;
  lease: ArgusTaskLease | null;
}
export interface ArgusProjectState {
  version: 2;
  automakerProjectId: string;
  argusProjectId: string;
  argusSessionId: string;
  objectiveHash: string;
  specHash: string;
  specRevision: number;
  autonomy: 'enabled' | 'paused' | 'error';
  phase: ArgusPhase;
  executor: 'jules' | 'senior';
  retryCounters: { julesRepair: number; seniorFeedback: number };
  git: { remoteSha?: string; localSha?: string };
  roles: Record<ArgusRole, ArgusRoleContext>;
  managerStatus: string;
  plannerStatus: string;
  activeTask: ArgusTaskState | null;
  latestStatus: string;
  updatedAt: string;
}
export interface ArgusRuntimeHealth {
  running: boolean;
  upstreamInstalled: boolean;
  version?: string;
  error?: string;
}
export interface ArgusProjectInput {
  projectId: string;
  projectPath: string;
  model: string;
}
export interface ArgusService {
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<ArgusRuntimeHealth>;
  createOrResolveProject(input: ArgusProjectInput): Promise<ArgusProjectState>;
  resumeProject(projectPath: string): Promise<ArgusProjectState>;
  managerHandoff(projectPath: string): Promise<ArgusManagerDecision>;
  plannerNextTask(
    projectPath: string,
    decision: ArgusManagerDecision
  ): Promise<ArgusPlannedTask | null>;
  getPendingWork(projectPath: string): Promise<ArgusPlannedTask[]>;
  getRecentEvents(projectPath: string): Promise<Array<Record<string, unknown>>>;
  getStatus(projectPath: string): Promise<ArgusProjectState | undefined>;
}
export interface DeveloperExecutor<TTask = ArgusTaskState> {
  readonly id: 'jules' | 'test';
  dispatch(task: TTask, projectPath: string): Promise<void>;
  reconcile(task: TTask, projectPath: string): Promise<void>;
}

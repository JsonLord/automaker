export type ArgusRole = 'manager' | 'planner' | 'reviewer' | 'senior-engineer';
export type ArgusPhase =
  | 'idle'
  | 'planning'
  | 'awaiting-executor'
  | 'jules-running'
  | 'pr-open'
  | 'ci-check'
  | 'ci-failed'
  | 'jules-repair'
  | 'senior-diagnosis'
  | 'senior-guided-repair'
  | 'senior-review'
  | 'review-changes'
  | 'senior-takeover'
  | 'senior-patch-ready'
  | 'approved'
  | 'merge-ready'
  | 'merge-intent'
  | 'merging'
  | 'merged'
  | 'git-recovery'
  | 'local-sync'
  | 'local-synced'
  | 'done'
  | 'objective-evaluation'
  | 'objective-satisfied'
  | 'spec-renewal'
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
export interface JulesDispatchIntent {
  taskId: string;
  dispatchAttemptId: string;
  source: string;
  repository: string;
  baseBranch: string;
  baseRemoteSha: string;
  deterministicMarker: string;
  startedAt: string;
  remoteOutcome: 'unknown' | 'created';
}
export interface MergeIntent {
  mergeAttemptId: string;
  prNumber: number;
  expectedHeadSha: string;
  baseBranch: string;
  baseBeforeMergeSha: string;
  mergeOutcome: 'unknown' | 'merged' | 'failed';
  attemptedAt: string;
}
export interface RecoverySnapshot {
  kind: 'dirty-worktree' | 'local-divergence';
  ref: string;
  objectSha: string;
  originalHead: string;
  createdAt: string;
}
export type CiState =
  | 'pending'
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'unknown'
  | 'not-configured';
export interface CiFailureSummary {
  workflowName: string;
  workflowRunId: string;
  jobName: string;
  jobId: string;
  failedStep: string;
  conclusion: string;
  excerpt: string;
  observedAt: string;
}
export interface SeniorDiagnosis {
  rootCause: string;
  recommendedFix: string;
  juniorCanRepair: boolean;
  evidence: string[];
  filesLikelyAffected: string[];
}
export interface ReviewFinding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  file?: string;
  line?: number;
  description: string;
  evidence: string;
}
export interface SeniorReview {
  verdict: 'approve' | 'request_changes' | 'blocked';
  reviewedHeadSha: string;
  findings: ReviewFinding[];
  requiredChanges: string[];
  evidence: string[];
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
  repository: string | null;
  prHeadSha: string | null;
  reviewedHeadSha: string | null;
  mergedSha: string | null;
  localSyncedSha: string | null;
  retryCount: number;
  lastArgusEvent: string;
  blockedReason: string | null;
  lease: ArgusTaskLease | null;
  dispatchIntent: JulesDispatchIntent | null;
  ciHeadSha: string | null;
  ciState: CiState;
  ciObservedAt: string | null;
  ciRunIds: string[];
  failingChecks: CiFailureSummary[];
  repairKind: 'ci' | 'review' | null;
  julesRepairAttempt: number;
  seniorGuidedRepairAttempt: number;
  repairSessionId: string | null;
  repairAgainstHeadSha: string | null;
  seniorDiagnosis: SeniorDiagnosis | null;
  reviewVerdict: SeniorReview['verdict'] | null;
  reviewFindings: ReviewFinding[];
  seniorWorktreePath: string | null;
  seniorBranch: string | null;
  seniorBaseHeadSha: string | null;
  seniorExecutionContextId: string | null;
  nextAction: string | null;
  events: Array<{ type: string; at: string; details?: Record<string, unknown> }>;
  mergeIntent: MergeIntent | null;
  mergeExpectedHeadSha: string | null;
  mergeAttemptedAt: string | null;
  mergeCommitSha: string | null;
  baseHeadAfterMergeSha: string | null;
  mergedAt: string | null;
  remoteBaseSha: string | null;
  localBaseSha: string | null;
  recoveryRef: string | null;
  recoveryReason: string | null;
  recoveryOriginalHead: string | null;
  recoveryCreatedAt: string | null;
  recoverySnapshots: RecoverySnapshot[];
  objectiveEvaluation: ObjectiveEvaluation | null;
}
export interface ObjectiveGap {
  title: string;
  description: string;
  evidence: string[];
}
export interface ObjectiveEvaluation {
  satisfied: boolean;
  reasoning: string;
  evidence: string[];
  remainingGaps: ObjectiveGap[];
}
export interface ArgusProjectState {
  version: 2;
  automakerProjectId: string;
  argusProjectId: string;
  argusCorrelationId: string;
  argusSessionId: string;
  objectiveHash: string;
  specHash: string;
  specRevision: number;
  autonomy: 'enabled' | 'paused' | 'error' | 'satisfied';
  phase: ArgusPhase;
  executor: 'jules' | 'senior';
  retryCounters: { julesRepair: number; seniorFeedback: number };
  git: { remoteSha?: string; localSha?: string };
  roles: Record<ArgusRole, ArgusRoleContext>;
  managerStatus: string;
  plannerStatus: string;
  activeTask: ArgusTaskState | null;
  latestStatus: string;
  previousSpecHashes?: string[];
  consecutiveSpecRenewalsWithoutCompletedTask?: number;
  reconciliation: {
    nextAt: string | null;
    reason: string | null;
    attempt: number;
    lastStartedAt: string | null;
    lastFinishedAt: string | null;
    lastError: string | null;
  };
  updatedAt: string;
}
export interface ArgusRuntimeHealth {
  running: boolean;
  upstreamInstalled: boolean;
  version?: string;
  home?: string;
  provider?: string;
  model?: string;
  roleBackends?: Record<string, string | undefined>;
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
  evaluateObjective(
    projectPath: string,
    evidence: Record<string, unknown>
  ): Promise<ObjectiveEvaluation>;
  renewSpecification(projectPath: string, evaluation: ObjectiveEvaluation): Promise<string>;
  getStatus(projectPath: string): Promise<ArgusProjectState | undefined>;
}
export interface DeveloperExecutor<TTask = ArgusTaskState> {
  readonly id: 'jules' | 'test';
  dispatch(task: TTask, projectPath: string): Promise<void>;
  reconcile(task: TTask, projectPath: string): Promise<void>;
}

/** Mode choice never grants autonomy or tool permissions. */
export const ARGUS_MODE_IDS = ['default', 'rea', 'paper2code', 'eval'] as const;
export type ArgusModeId = (typeof ARGUS_MODE_IDS)[number];
export interface ArgusModeConfig {
  capabilities: { repositoryRead: boolean; referenceImplementation: boolean; llmJudge: boolean };
  permissions: { repositoryChanges: boolean; modelCalls: boolean };
  evaluation: { minimumScore: number; requireJudge: boolean };
}
export interface ModeSource {
  id: string;
  kind: 'observation' | 'repository';
  text?: string;
  path?: string;
}
export interface ModeExample {
  id: string;
  input: number[];
  expected: number;
}
export interface ModeDatasetRow {
  id: string;
  input: string;
  expected: string;
  actual: string;
}
export interface ArgusModeInput {
  question: string;
  authorized?: boolean;
  targetKind?: 'web' | 'api' | 'source' | 'native';
  sources?: ModeSource[];
  hypotheses?: Array<{ id: string; sourceId: string; contains: string; claim: string }>;
  paper?: {
    title: string;
    reference?: string;
    text?: string;
    documentPath?: string;
    algorithm?: 'mean' | 'sum' | 'linear';
    slope?: number;
    intercept?: number;
    ambiguities?: string[];
    examples?: ModeExample[];
  };
  dataset?: {
    id: string;
    version: string;
    rubricVersion: string;
    rule: 'exact' | 'contains' | 'numeric';
    tolerance?: number;
    candidates: Array<{ id: string; model: string; commitSha: string; rows: ModeDatasetRow[] }>;
  };
  useJudge?: boolean;
  baselineRunId?: string;
}
export interface ArgusModeTask {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  evidenceIds: string[];
  admittedTaskId?: string;
}
export interface ArgusModeArtifact {
  name: string;
  content: string;
  sha256: string;
  evidenceId: string;
  mediaType: 'application/json' | 'text/markdown' | 'text/javascript';
}
export interface ArgusModeEvaluation {
  verdict: 'PASS' | 'FAIL' | 'BLOCKED';
  score: number | null;
  reasons: string[];
  advisory: boolean;
}
export interface ArgusModeRun {
  id: string;
  idempotencyKey: string;
  mode: ArgusModeId;
  config: ArgusModeConfig;
  configRevision: number;
  sourceSha: string | null;
  status: 'planned' | 'running' | 'completed' | 'blocked' | 'failed' | 'interrupted';
  input: ArgusModeInput;
  steps: string[];
  tasks: ArgusModeTask[];
  artifacts: ArgusModeArtifact[];
  evaluation: ArgusModeEvaluation | null;
  createdAt: string;
  finishedAt?: string;
  deadlineAt?: string;
  owner?: string;
  worktreePath?: string;
  worktreeIntent?: { branch: string; baseSha: string };
  events: Array<{ id: string; type: string; at: string }>;
}
export interface ArgusModeState {
  version: 1;
  revision: number;
  activeMode: ArgusModeId;
  configurationRevision: number;
  configs: Record<ArgusModeId, ArgusModeConfig>;
  runs: ArgusModeRun[];
  history: Array<{ revision: number; mode: ArgusModeId; at: string }>;
}
export interface ArgusModeDescriptor {
  id: ArgusModeId;
  label: string;
  description: string;
  adapterVersion: string;
  upstream?: { url: string; revision: string; license: string; integration: string };
}

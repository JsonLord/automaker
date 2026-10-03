import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import YAML from 'yaml';
import type { ArgusProjectState, ArgusRole } from './types.js';

const POLICY = {
  version: 1,
  autonomy: { enabled: true, mode: 'yolo', resume_on_startup: true, deployment: 'disabled' },
  routing: {
    default_executor: 'jules',
    senior_executor: 'opencode',
    reviewer: 'opencode',
    jules_ci_repair_attempts: 2,
    senior_feedback_then_jules_attempts: 1,
  },
  merge: {
    strategy: 'merge',
    require_ci_green: true,
    require_senior_review: true,
    require_exact_head_sha: true,
  },
  git: { remote: 'origin', sync_on_startup: true, sync_after_merge: true },
};

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const stableId = (projectId: string) => `argus-${hash(projectId).slice(0, 24)}`;
const roleContext = (id: string, role: ArgusRole, model: string) => ({
  role,
  backend: 'opencode' as const,
  model,
  contextId: `${id}-${role}-${crypto.randomUUID()}`,
  readOnly: role === 'reviewer',
});

async function readOptional(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

export async function saveArgusState(projectPath: string, state: ArgusProjectState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  const statePath = path.join(projectPath, '.automaker', 'argus-state.json');
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export async function ensureArgusControlFiles(
  projectPath: string,
  spec: string,
  objective?: string
) {
  const charterPath = path.join(projectPath, 'ARGUS.md');
  if (!(await readOptional(charterPath))) {
    const charter = `# Project Objective\n\n## North-star objective\n${objective || spec.slice(0, 500)}\n\n## Success conditions\n- The current specification is implemented and verified.\n\n## Architecture constraints\n- Preserve the existing architecture unless the specification requires change.\n\n## Non-goals\n- Deployment and publishing are excluded.\n\n## Quality and test expectations\n- Relevant tests, type checking, and builds must pass.\n\n## Definition of done\n- The objective is satisfied with reviewable evidence.\n`;
    await fs.writeFile(charterPath, charter);
  }
  await fs.writeFile(path.join(projectPath, 'spec.md'), spec);
  const automakerDir = path.join(projectPath, '.automaker');
  await fs.mkdir(automakerDir, { recursive: true });
  const policyPath = path.join(automakerDir, 'argus.yaml');
  if (!(await readOptional(policyPath))) await fs.writeFile(policyPath, YAML.stringify(POLICY));
}

export async function migrateArgusControlFiles(projectPath: string): Promise<boolean> {
  const spec = await readOptional(path.join(projectPath, 'spec.md'));
  const charter = await readOptional(path.join(projectPath, 'ARGUS.md'));
  if (!spec && !charter) return false;
  await ensureArgusControlFiles(projectPath, spec || charter, charter || undefined);
  return true;
}

export async function resolveState(
  projectId: string,
  projectPath: string,
  model: string
): Promise<ArgusProjectState> {
  const statePath = path.join(projectPath, '.automaker', 'argus-state.json');
  const objective = await readOptional(path.join(projectPath, 'ARGUS.md'));
  const spec = await readOptional(path.join(projectPath, 'spec.md'));
  try {
    const existing = JSON.parse(await fs.readFile(statePath, 'utf8')) as ArgusProjectState;
    existing.version = 2;
    existing.managerStatus ||= 'idle';
    existing.plannerStatus ||= 'idle';
    existing.activeTask ??= null;
    const nextHash = hash(spec);
    if (existing.specHash !== nextHash) {
      existing.specHash = nextHash;
      existing.specRevision += 1;
    }
    existing.objectiveHash = hash(objective);
    existing.updatedAt = new Date().toISOString();
    await saveArgusState(projectPath, existing);
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const id = stableId(projectId);
  const roles = Object.fromEntries(
    (['manager', 'planner', 'reviewer', 'senior-engineer'] as ArgusRole[]).map((role) => [
      role,
      roleContext(id, role, model),
    ])
  ) as ArgusProjectState['roles'];
  const state: ArgusProjectState = {
    version: 2,
    automakerProjectId: projectId,
    argusProjectId: id,
    argusSessionId: `${id}-session`,
    objectiveHash: hash(objective),
    specHash: hash(spec),
    specRevision: 1,
    autonomy: 'enabled',
    phase: 'planning',
    executor: 'jules',
    retryCounters: { julesRepair: 0, seniorFeedback: 0 },
    git: {},
    roles,
    managerStatus: 'idle',
    plannerStatus: 'idle',
    activeTask: null,
    latestStatus: 'Argus project registered; remote execution is disabled until Milestone C.',
    updatedAt: new Date().toISOString(),
  };
  await saveArgusState(projectPath, state);
  return state;
}

export { POLICY as DEFAULT_ARGUS_POLICY };

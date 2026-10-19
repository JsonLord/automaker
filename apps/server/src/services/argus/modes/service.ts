import crypto from 'crypto';
import { execGitCommand } from '@automaker/git-utils';
import type {
  ArgusModeConfig,
  ArgusModeId,
  ArgusModeInput,
  ArgusModeRun,
  ArgusModeState,
} from '@automaker/types';
import { readDurableJson, updateDurableJson } from '../durable-store.js';
import type { ArgusService, ArgusPlannedTask } from '../types.js';
import type { FeatureLoader } from '../../feature-loader.js';
import { ArgusOrchestrator } from '../orchestrator.js';
import {
  artifact,
  defaultConfig,
  digest,
  invariant,
  modeConfigSchema,
  modeIdSchema,
  modeInputSchema,
  ModeError,
  sanitize,
} from './contracts.js';
import { createModeRegistry, MODE_DESCRIPTORS } from './registry.js';
import { modeStateFile, withModeFence } from './control.js';

const stamp = () => new Date().toISOString();
const event = (type: string) => ({ id: crypto.randomUUID(), type, at: stamp() });
const initial = (): ArgusModeState => ({
  version: 1,
  revision: 0,
  activeMode: 'default',
  configurationRevision: 0,
  configs: {
    default: defaultConfig(),
    rea: defaultConfig(),
    paper2code: defaultConfig(),
    eval: defaultConfig(),
  },
  runs: [],
  history: [],
});
const activePhases = new Set(['done', 'objective-satisfied']);
async function sourceSha(root: string) {
  try {
    const sha = (await execGitCommand(['rev-parse', 'HEAD'], root)).trim();
    return /^(?!0{40}$)[0-9a-f]{40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}
export class ArgusModeService {
  readonly descriptors = MODE_DESCRIPTORS;
  private registry;
  constructor(
    private argus: ArgusService,
    private features?: FeatureLoader,
    registry = createModeRegistry(argus)
  ) {
    this.registry = registry;
  }
  private checked(value: ArgusModeState | undefined) {
    if (!value) return initial();
    invariant(
      value.version === 1 &&
        Number.isInteger(value.revision) &&
        Number.isInteger(value.configurationRevision) &&
        Array.isArray(value.runs) &&
        Array.isArray(value.history) &&
        value.configs,
      'MODE_STATE_CORRUPT',
      503
    );
    for (const id of ['default', 'rea', 'paper2code', 'eval'] as const)
      modeConfigSchema.parse(value.configs[id]);
    if (!this.registry.has(value.activeMode)) value.activeMode = 'default';
    return value;
  }
  private update(root: string, operation: (state: ArgusModeState) => void | Promise<void>) {
    return updateDurableJson<ArgusModeState>(modeStateFile(root), async (disk) => {
      const state = this.checked(disk);
      await operation(state);
      state.revision++;
      return state;
    });
  }
  async state(root: string) {
    const state = this.checked(await readDurableJson<ArgusModeState>(modeStateFile(root)));
    if (
      !state.runs.some((r) => r.status === 'running' && Date.parse(r.deadlineAt || '') < Date.now())
    )
      return state;
    const recovered = await this.update(root, (s) => {
      for (const run of s.runs)
        if (run.status === 'running' && Date.parse(run.deadlineAt || '') < Date.now()) {
          run.status = 'interrupted';
          run.finishedAt = stamp();
          run.events.push(event('RECOVERED_INTERRUPTED_NO_REPLAY'));
          run.evaluation = {
            verdict: 'BLOCKED',
            score: null,
            reasons: [
              'Execution deadline expired. Inspect recorded worktree/task effects before creating a new run; execution is never automatically replayed.',
            ],
            advisory: false,
          };
        }
    });
    for (const run of recovered.runs)
      if (run.status === 'interrupted') await this.project(root, run);
    return recovered;
  }
  async select(root: string, id: ArgusModeId, config?: ArgusModeConfig, expectedRevision?: number) {
    modeIdSchema.parse(id);
    const parsed = config ? modeConfigSchema.parse(config) : undefined;
    return withModeFence(root, async () => {
      const argus = await this.argus.getStatus(root);
      return this.update(root, (s) => {
        invariant(
          expectedRevision === undefined || expectedRevision === s.revision,
          'MODE_REVISION_CONFLICT'
        );
        invariant(!s.runs.some((r) => r.status === 'running'), 'MODE_RUN_ACTIVE');
        invariant(
          !argus?.activeTask || activePhases.has(argus.activeTask.phase),
          'MODE_ENGINEERING_TASK_ACTIVE'
        );
        const changed =
          s.activeMode !== id ||
          (parsed && JSON.stringify(s.configs[id]) !== JSON.stringify(parsed));
        if (changed) {
          invariant(s.history.length < 1000, 'MODE_HISTORY_ARCHIVE_REQUIRED');
          s.activeMode = id;
          if (parsed) s.configs[id] = parsed;
          s.configurationRevision++;
          s.history.push({ revision: s.revision + 1, mode: id, at: stamp() });
        }
      });
    });
  }
  async command(root: string, command: string) {
    const match = /^\/(default|rea|paper2code|eval)$/.exec(command.trim());
    invariant(match, 'MODE_COMMAND_SELECTION_ONLY', 400);
    const mode = match[1] as ArgusModeId;
    const state = await this.select(root, mode);
    return {
      mode,
      revision: state.revision,
      description: this.descriptors.find((d) => d.id === mode)!.description,
      message: 'Mode selected. Autonomy is unchanged. Use Plan and Run explicitly.',
    };
  }
  async plan(root: string, input: ArgusModeInput, idempotencyKey: string) {
    invariant(/^[a-zA-Z0-9_-]{1,100}$/.test(idempotencyKey), 'MODE_IDEMPOTENCY_KEY_REQUIRED', 400);
    const parsed = sanitize(modeInputSchema.parse(input));
    invariant(Buffer.byteLength(JSON.stringify(parsed)) <= 131072, 'MODE_INPUT_TOO_LARGE', 413);
    const sha = await sourceSha(root);
    return withModeFence(root, async () => {
      const state = await this.update(root, async (s) => {
        const existing = s.runs.find((r) => r.idempotencyKey === idempotencyKey);
        if (existing) {
          invariant(
            existing.mode === s.activeMode &&
              existing.configRevision === s.configurationRevision &&
              digest(JSON.stringify(existing.input)) === digest(JSON.stringify(parsed)),
            'MODE_IDEMPOTENCY_CONFLICT'
          );
          return;
        }
        invariant(!s.runs.some((r) => r.status === 'running'), 'MODE_RUN_ACTIVE');
        const current = await this.argus.getStatus(root);
        invariant(
          !current?.activeTask || activePhases.has(current.activeTask.phase),
          'MODE_ENGINEERING_TASK_ACTIVE'
        );
        invariant(s.runs.length < 200, 'MODE_RUN_ARCHIVE_REQUIRED');
        const adapter = this.registry.get(s.activeMode)!;
        if (parsed.sources)
          invariant(
            new Set(parsed.sources.map((source) => source.id)).size === parsed.sources.length,
            'MODE_DUPLICATE_SOURCE_ID',
            400
          );
        const gaps = await adapter.validate(s.configs[s.activeMode], parsed);
        const blocked = gaps.length > 0;
        const run: ArgusModeRun = {
          id: crypto.randomUUID(),
          idempotencyKey,
          mode: s.activeMode,
          config: structuredClone(s.configs[s.activeMode]),
          configRevision: s.configurationRevision,
          sourceSha: sha,
          status: blocked ? 'blocked' : 'planned',
          input: parsed,
          steps: adapter.plan(parsed),
          tasks: [],
          artifacts: [],
          evaluation: blocked
            ? { verdict: 'BLOCKED', score: null, reasons: gaps, advisory: false }
            : null,
          createdAt: stamp(),
          events: [event(blocked ? 'VALIDATION_BLOCKED' : 'PLAN_CREATED')],
        };
        if (blocked)
          run.artifacts = [
            artifact(
              `${run.mode}-blocked-report.md`,
              `# ${run.mode}: BLOCKED\n\n${gaps.join('\n')}\n\nNo execution occurred.`
            ),
          ];
        s.runs.push(run);
      });
      const planned = state.runs.find((r) => r.idempotencyKey === idempotencyKey)!;
      await this.project(root, planned);
      return planned;
    });
  }
  async run(root: string, id: string, approval?: { repositoryChanges: true; sourceSha: string }) {
    return withModeFence(root, async () => {
      const state = await this.state(root);
      const planned = state.runs.find((r) => r.id === id);
      invariant(planned, 'MODE_RUN_NOT_FOUND', 404);
      if (planned.status !== 'planned') return planned;
      invariant(
        planned.mode === state.activeMode && planned.configRevision === state.configurationRevision,
        'MODE_PLAN_STALE'
      );
      const current = await this.argus.getStatus(root);
      invariant(
        !current?.activeTask || activePhases.has(current.activeTask.phase),
        'MODE_ENGINEERING_TASK_ACTIVE'
      );
      invariant(!state.runs.some((r) => r.status === 'running'), 'MODE_CONCURRENCY_LIMIT');
      const sha = await sourceSha(root);
      invariant(sha === planned.sourceSha, 'MODE_SOURCE_CHANGED');
      if (approval)
        invariant(
          approval.repositoryChanges === true &&
            planned.config.permissions.repositoryChanges &&
            approval.sourceSha === sha &&
            sha,
          'MODE_APPROVAL_REQUIRED',
          403
        );
      invariant(
        !planned.input.baselineRunId ||
          state.runs.some((r) => r.id === planned.input.baselineRunId),
        'MODE_BASELINE_NOT_FOUND',
        404
      );
      const owner = crypto.randomUUID();
      await this.update(root, (s) => {
        const run = s.runs.find((r) => r.id === id)!;
        invariant(run.status === 'planned', 'MODE_RUN_ACTIVE');
        if (approval && run.mode === 'paper2code')
          run.worktreeIntent = { branch: `argus-mode-${run.id}`, baseSha: approval.sourceSha };
        run.status = 'running';
        run.owner = owner;
        run.deadlineAt = new Date(Date.now() + 600000).toISOString();
        run.events.push(event('EXECUTION_STARTED'));
      });
      await this.project(root, { ...planned, status: 'running' });
      const signal = AbortSignal.timeout(180000);
      try {
        const result = await this.registry.get(planned.mode)!.execute({
          projectPath: root,
          run: planned,
          approval,
          signal,
          baseline: planned.input.baselineRunId
            ? state.runs.find((r) => r.id === planned.input.baselineRunId)
            : undefined,
        });
        signal.throwIfAborted();
        invariant(
          !planned.input.baselineRunId ||
            state.runs.some((r) => r.id === planned.input.baselineRunId),
          'MODE_BASELINE_NOT_FOUND',
          404
        );
        const evaluated = this.registry.get(planned.mode)!.evaluate(result);
        await this.update(root, (s) => {
          const run = s.runs.find((r) => r.id === id)!;
          invariant(run.status === 'running' && run.owner === owner, 'MODE_RUN_LEASE_LOST');
          run.status = evaluated.verdict === 'BLOCKED' ? 'blocked' : 'completed';
          run.tasks = sanitize(result.tasks);
          run.artifacts = result.artifacts;
          run.evaluation = sanitize(evaluated);
          run.worktreePath = result.worktreePath;
          run.finishedAt = stamp();
          run.events.push(event('EXECUTION_FINISHED'));
        });
      } catch (error) {
        const reason =
          error instanceof ModeError
            ? error.code
            : 'MODE_EXECUTION_FAILED_OR_DEPENDENCY_UNAVAILABLE';
        await this.update(root, (s) => {
          const run = s.runs.find((r) => r.id === id)!;
          if (run.status !== 'running' || run.owner !== owner) return;
          run.status = error instanceof ModeError ? 'blocked' : 'failed';
          run.finishedAt = stamp();
          run.evaluation = { verdict: 'BLOCKED', score: null, reasons: [reason], advisory: false };
          run.artifacts = [
            artifact(
              `${run.mode}-blocked-report.md`,
              `# Execution blocked\n\n${reason}\n\nNo result or score has been fabricated. Inspect run/worktree intent before a new run.`
            ),
          ];
          run.events.push(event('EXECUTION_BLOCKED'));
        });
      }
      const run = await this.get(root, id);
      await this.project(root, run);
      return run;
    });
  }
  async get(root: string, id: string) {
    invariant(/^[a-zA-Z0-9_-]{1,100}$/.test(id), 'MODE_RUN_NOT_FOUND', 404);
    const run = (await this.state(root)).runs.find((r) => r.id === id);
    invariant(run, 'MODE_RUN_NOT_FOUND', 404);
    return run;
  }
  async approveTask(root: string, id: string, taskId: string, source: string) {
    invariant(this.features, 'MODE_FEATURE_SERVICE_UNAVAILABLE', 503);
    return withModeFence(root, async () => {
      const state = await this.state(root),
        run = state.runs.find((r) => r.id === id),
        task = run?.tasks.find((t) => t.id === taskId);
      invariant(run && task, 'MODE_TASK_NOT_FOUND', 404);
      invariant(
        run.configRevision === state.configurationRevision && run.mode === state.activeMode,
        'MODE_PLAN_STALE'
      );
      invariant(
        run.config.permissions.repositoryChanges &&
          source === run.sourceSha &&
          source === (await sourceSha(root)),
        'MODE_APPROVAL_REQUIRED',
        403
      );
      const argus = await this.argus.getStatus(root);
      invariant(argus?.autonomy === 'enabled', 'MODE_EXISTING_AUTONOMY_APPROVAL_REQUIRED', 403);
      const admittedId =
        run.mode === 'default' ? task.id : `mode-${run.id}-${digest(task.id).slice(0, 12)}`;
      if (!argus.activeTask || argus.activeTask.taskId !== admittedId) {
        invariant(!argus.activeTask, 'MODE_ENGINEERING_TASK_ACTIVE');
        invariant(!task.admittedTaskId, 'MODE_TASK_ALREADY_ADMITTED');
        // Persist intent before admitting a task. Recovery uses the deterministic identity.
        await this.update(root, (s) => {
          s.runs
            .find((r) => r.id === id)!
            .events.push(event(`TASK_APPROVED_${digest(task.id).slice(0, 12)}`));
        });
        const originalPlan =
          run.mode === 'default'
            ? (JSON.parse(run.artifacts.find((a) => a.name === 'default-plan.json')!.content)
                .task as ArgusPlannedTask)
            : undefined;
        if (originalPlan) invariant(originalPlan.taskId === task.id, 'MODE_PLAN_IDENTITY_MISMATCH');
        const proposed: ArgusPlannedTask = originalPlan || {
          taskId: admittedId,
          title: task.title,
          objective: run.input.question,
          description: task.description,
          acceptanceCriteria: task.acceptanceCriteria,
          evidenceRequired: task.evidenceIds,
          recommendedExecutor: 'junior',
          dependencies: [],
          risk: 'Mode-generated task requires normal CI, Loki, review and manual merge.',
          sourceSpecRevision: argus.specRevision,
        };
        const admitted = await new ArgusOrchestrator(this.argus, this.features!).admitPlannedTask(
          root,
          {
            ...proposed,
            taskId: admittedId,
            modeId: run.mode,
            modeRunId: run.id,
            requiresHumanMerge: true,
          }
        );
        invariant(admitted?.taskId === admittedId, 'MODE_TASK_ADMISSION_FAILED');
      }
      await this.update(root, (s) => {
        s.runs.find((r) => r.id === id)!.tasks.find((t) => t.id === taskId)!.admittedTaskId =
          admittedId;
      });
      const updated = await this.get(root, id);
      await this.project(root, updated);
      return updated;
    });
  }
  async gate(root: string) {
    const state = await this.state(root),
      sha = await sourceSha(root);
    let clean = false;
    try {
      clean = !(
        await execGitCommand(['status', '--porcelain', '--untracked-files=no'], root)
      ).trim();
    } catch {
      /* no Git identity is not release evidence */
    }
    const run = clean
      ? [...state.runs]
          .reverse()
          .find(
            (r) =>
              r.mode === 'eval' &&
              r.status === 'completed' &&
              r.sourceSha === sha &&
              r.configRevision === state.configurationRevision
          )
      : undefined;
    return {
      verdict: run?.evaluation?.verdict || 'BLOCKED',
      runId: run?.id || null,
      sourceSha: sha,
      evidenceIds: run?.artifacts.map((a) => a.evidenceId) || [],
      reason: run
        ? 'Evaluation recommendation; existing CI, review, Loki and human merge gates still apply.'
        : 'No current-source evaluation with the current configuration.',
      authorizesMerge: false,
    };
  }
  private async project(root: string, run: ArgusModeRun) {
    if (!this.features) return;
    const id = `argus-mode-${run.id}`;
    const value = {
      id,
      title: `${this.descriptors.find((d) => d.id === run.mode)!.label}: ${run.input.question.slice(0, 100)}`,
      description: `Mode run ${run.id}\n${run.evaluation?.reasons.join('\n') || 'Evidence available in the Argus mode panel.'}`,
      category: 'Argus',
      orchestrator: 'argus',
      executionOwner: 'argus-autonomy',
      status:
        run.status === 'running'
          ? 'in_progress'
          : run.status === 'completed' && run.evaluation?.verdict === 'PASS'
            ? 'verified'
            : 'waiting_approval',
      argusMode: {
        mode: run.mode,
        runId: run.id,
        status: run.status,
        taskIds: run.tasks.map((t) => t.admittedTaskId || t.id),
        evidenceIds: run.artifacts.map((a) => a.evidenceId),
      },
    };
    if (await this.features.get(root, id)) await this.features.update(root, id, value);
    else await this.features.create(root, value);
  }
}

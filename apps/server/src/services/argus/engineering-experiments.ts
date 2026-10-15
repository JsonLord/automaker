import type { ArgusService } from './types.js';
import type { ArgusOrchestrator } from './orchestrator.js';
import path from 'path';
import crypto from 'crypto';
import { readDurableJson, updateDurableJson, withDurableLock } from './durable-store.js';
export interface ExperimentVariant {
  id: string;
  branch: string;
  headSha: string;
}
export interface ExperimentMeasurement {
  runId: string;
  headSha: string;
  isolated: boolean;
  correctness: boolean;
  value: number;
  artifact: string;
  tokenUnits?: number;
  costUsd?: number;
}
export interface EngineeringExperiment {
  id: string;
  hypothesisId: string;
  baseline: { value: number; headSha: string };
  metric: string;
  direction: 'min' | 'max';
  minimumImprovement: number;
  commands: string[];
  variants: ExperimentVariant[];
  results: Record<string, ExperimentMeasurement>;
  status: 'pending' | 'evaluating' | 'inconclusive' | 'selected';
  winner: string | null;
  attempts: number;
  maxTokenUnits?: number;
  maxCostUsd?: number;
}
export interface ParametersForExperimentWorker {
  runId: string;
  variant: ExperimentVariant;
  commands: string[];
  timeoutMs: number;
  worker?: { id: string; leaseId: string; expiresAt: string };
}
export interface IsolatedExperimentEvaluator {
  evaluate(job: ParametersForExperimentWorker): Promise<ExperimentMeasurement>;
}
/** No shell execution: a trusted external worker must attest each measurement. */
export class EngineeringExperiments {
  constructor(private evaluator?: IsolatedExperimentEvaluator) {}
  private file(root: string, id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('EXPERIMENT_ID_INVALID');
    return path.join(root, '.automaker', 'experiments', `${id}.json`);
  }
  async create(
    root: string,
    input: Omit<EngineeringExperiment, 'id' | 'results' | 'status' | 'winner' | 'attempts'>
  ) {
    if (
      input.variants.length < 2 ||
      input.variants.length > 3 ||
      new Set(input.variants.map((v) => v.id)).size !== input.variants.length ||
      !Number.isFinite(input.baseline.value) ||
      (input.maxTokenUnits !== undefined &&
        (!Number.isFinite(input.maxTokenUnits) || input.maxTokenUnits <= 0)) ||
      (input.maxCostUsd !== undefined &&
        (!Number.isFinite(input.maxCostUsd) || input.maxCostUsd <= 0)) ||
      !Number.isFinite(input.minimumImprovement) ||
      input.minimumImprovement < 0 ||
      !/^[a-f0-9]{40}$/.test(input.baseline.headSha) ||
      input.variants.some(
        (v) => v.id === 'baseline' || !v.branch || !/^[a-f0-9]{40}$/.test(v.headSha)
      ) ||
      input.commands.length < 1 ||
      input.commands.length > 5
    )
      throw new Error('EXPERIMENT_INVALID');
    const id = crypto.randomUUID();
    await updateDurableJson<string[]>(
      path.join(root, '.automaker', 'experiments', 'index.json'),
      (ids) => {
        if ((ids?.length || 0) >= 3) throw new Error('EXPERIMENT_BUDGET_EXHAUSTED');
        return [...(ids || []), id];
      }
    );
    const experiment: EngineeringExperiment = {
      ...input,
      id,
      results: {},
      status: 'pending',
      winner: null,
      attempts: 0,
    };
    await updateDurableJson(this.file(root, id), () => experiment);
    return experiment;
  }
  async evaluate(root: string, id: string) {
    return withDurableLock(path.join(root, '.automaker', 'experiments', 'evaluation'), () =>
      this.evaluateClaimed(root, id)
    );
  }
  private async evaluateClaimed(root: string, id: string) {
    // Persist the claim before sending work. A crashed/ambiguous run requires operator review, never automatic duplicate execution.
    const claimed = await updateDurableJson<EngineeringExperiment>(
      this.file(root, id),
      (current) => {
        if (!current) throw new Error('EXPERIMENT_NOT_FOUND');
        if (current.status !== 'pending') throw new Error('EXPERIMENT_ALREADY_CLAIMED');
        current.status = 'evaluating';
        current.attempts++;
        return current;
      }
    );
    if (this.evaluator) {
      for (const variant of [
        { id: 'baseline', branch: 'baseline', headSha: claimed.baseline.headSha },
        ...claimed.variants,
      ]) {
        const runId = crypto.randomUUID();
        try {
          const result = await this.evaluator.evaluate({
            runId,
            variant,
            commands: claimed.commands,
            timeoutMs: 120000,
          });
          if (
            result.runId === runId &&
            result.headSha === variant.headSha &&
            result.isolated &&
            result.correctness &&
            (claimed.maxTokenUnits === undefined ||
              (Number.isFinite(result.tokenUnits) &&
                result.tokenUnits! >= 0 &&
                Object.values(claimed.results).reduce((n, r) => n + (r.tokenUnits || 0), 0) +
                  result.tokenUnits! <=
                  claimed.maxTokenUnits)) &&
            (claimed.maxCostUsd === undefined ||
              (Number.isFinite(result.costUsd) &&
                result.costUsd! >= 0 &&
                Object.values(claimed.results).reduce((n, r) => n + (r.costUsd || 0), 0) +
                  result.costUsd! <=
                  claimed.maxCostUsd)) &&
            Number.isFinite(result.value) &&
            /^[a-zA-Z0-9._:/-]{1,200}$/.test(result.artifact)
          )
            claimed.results[variant.id] = result;
        } catch {
          /* Missing results are inconclusive, never success. */
        }
      }
    }
    const valid = claimed.variants.filter((v) => claimed.results[v.id]);
    claimed.status = 'inconclusive';
    if (
      valid.length === claimed.variants.length &&
      claimed.results.baseline?.value === claimed.baseline.value
    ) {
      valid.sort(
        (a, b) =>
          (claimed.results[a.id].value - claimed.results[b.id].value) *
          (claimed.direction === 'min' ? 1 : -1)
      );
      const best = claimed.results[valid[0].id].value;
      const improvement = (best - claimed.baseline.value) * (claimed.direction === 'max' ? 1 : -1);
      if (
        best !== claimed.results[valid[1].id].value &&
        improvement >= claimed.minimumImprovement
      ) {
        claimed.winner = valid[0].id;
        claimed.status = 'selected';
      }
    }
    await updateDurableJson(this.file(root, id), () => claimed);
    return claimed;
  }
  async admitWinner(root: string, id: string, argus: ArgusService, planner: ArgusOrchestrator) {
    const experiment = await readDurableJson<EngineeringExperiment>(this.file(root, id));
    const selected = await this.selected(root, id);
    if (!experiment || !selected) throw new Error('EXPERIMENT_NO_VERIFIED_WINNER');
    const context = {
      experiment,
      selectedVariant: selected,
      policy: 'Apply only the measured winner; all normal PR gates remain mandatory',
    };
    const decision = await argus.managerHandoff(root, context);
    if (!decision.admitted || !decision.evidence?.length) return null;
    const planned = await argus.plannerNextTask(root, decision, context);
    if (!planned) return null;
    return planner.admitPlannedTask(
      root,
      {
        ...planned,
        taskId: `experiment-${id}`,
        experimentId: id,
        selectedVariantSha: selected.headSha,
        description: `${planned.description}\nApply ONLY selected variant ${selected.branch} at exact SHA ${selected.headSha}. Re-run all normal verification gates.`,
        evidenceRequired: [...planned.evidenceRequired, `Measured winner: ${selected.headSha}`],
      },
      true
    );
  }
  async selected(root: string, id: string) {
    const e = await readDurableJson<EngineeringExperiment>(this.file(root, id));
    return e?.status === 'selected' ? e.variants.find((v) => v.id === e.winner) : undefined;
  }
}

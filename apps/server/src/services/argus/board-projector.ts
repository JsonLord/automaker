import path from 'path';
import type { PipelineConfig, Feature } from '@automaker/types';
import type { FeatureLoader } from '../feature-loader.js';
import type { ArgusTaskState } from './types.js';
import { updateDurableJson } from './durable-store.js';
import { redactOpenCodeEvent } from '../../lib/opencode-errors.js';
export function isArgusOwned(feature: Partial<Feature> | undefined | null) {
  return Boolean(
    feature &&
    (feature.category === 'Argus' ||
      feature.orchestrator === 'argus' ||
      feature.executionOwner === 'argus-autonomy' ||
      feature.argus)
  );
}
export const ARGUS_LANES = [
  ['argus-loki', 'Loki Gate'],
  ['argus-ci', 'QA / CI'],
  ['argus-senior', 'Senior Review'],
  ['argus-merge', 'Merge Gate'],
] as const;
export class ArgusBoardProjector {
  constructor(private features: FeatureLoader) {}
  status(task: ArgusTaskState): string {
    if (
      ['done', 'objective-satisfied', 'objective-evaluation', 'spec-renewal'].includes(
        task.phase
      ) &&
      task.mergeCommitSha &&
      task.localSyncedSha
    )
      return 'verified';
    if (['blocked', 'error', 'senior-patch-ready'].includes(task.phase)) return 'waiting_approval';
    if (task.phase === 'awaiting-executor') return 'backlog';
    if (task.phase === 'loki-gate') return 'pipeline_argus-loki';
    if (['pr-open', 'ci-check', 'ci-failed'].includes(task.phase)) return 'pipeline_argus-ci';
    if (
      [
        'senior-review',
        'review-changes',
        'senior-diagnosis',
        'senior-takeover',
        'approved',
      ].includes(task.phase)
    )
      return 'pipeline_argus-senior';
    if (
      [
        'merge-ready',
        'merge-intent',
        'merging',
        'merged',
        'git-recovery',
        'local-sync',
        'local-synced',
      ].includes(task.phase)
    )
      return 'pipeline_argus-merge';
    return 'in_progress';
  }
  async project(root: string, task: ArgusTaskState) {
    await updateDurableJson<PipelineConfig>(
      path.join(root, '.automaker', 'pipeline.json'),
      (current) => {
        current ||= { version: 1, steps: [] };
        for (const [id, name] of ARGUS_LANES)
          if (!current.steps.some((s) => s.id === id))
            current.steps.push({
              id,
              name,
              order: current.steps.length,
              instructions: 'Argus projection only. Use campaign controls.',
              colorClass: 'bg-violet-500',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
        return current;
      }
    );
    const existing = await this.features.get(root, task.featureId);
    const feature = {
      id: task.featureId,
      title: task.title,
      category: 'Argus',
      orchestrator: 'argus',
      executionOwner: 'argus-autonomy',
      description: task.description,
      status: this.status(task),
      dependencies: task.dependencies,
      planningMode: 'skip' as const,
      requirePlanApproval: false,
      ...(task.modeId && task.modeRunId
        ? {
            argusMode: {
              mode: task.modeId,
              runId: task.modeRunId,
              status: task.phase,
              taskIds: [task.taskId],
              evidenceIds: task.evidenceRequired,
            },
          }
        : {}),
      argus: redactOpenCodeEvent({ ...task }),
    };
    if (existing) await this.features.update(root, task.featureId, feature);
    else await this.features.create(root, feature);
  }
}

import path from 'path';
import crypto from 'crypto';
import type { ArgusTaskState } from './types.js';
import { updateDurableJson, readDurableJson } from './durable-store.js';
import { redactOpenCodeEvent } from '../../lib/opencode-errors.js';
export interface TaskOutcome {
  taskId: string;
  featureId: string;
  outcome: 'completed' | 'blocked';
  repository: string | null;
  prNumber: number | null;
  headSha: string | null;
  mergeSha: string | null;
  localSyncedSha: string | null;
  blockedReason: string | null;
  repairs: number;
  loki: ArgusTaskState['lokiEvidence'];
  ciHeadSha: string | null;
  ciState: string;
  seniorHeadSha: string | null;
  seniorVerdict: string | null;
  archivedAt: string;
  experimentId?: string;
}
export class TaskHistoryStore {
  private index(projectPath: string) {
    return path.join(projectPath, '.automaker', 'task-history.json');
  }
  async archive(projectPath: string, task: ArgusTaskState, outcome: 'completed' | 'blocked') {
    const hash = crypto.createHash('sha256').update(task.taskId).digest('hex');
    await updateDurableJson(path.join(projectPath, '.automaker', 'tasks', `${hash}.json`), () =>
      redactOpenCodeEvent({ ...task, outcome, archivedAt: new Date().toISOString() })
    );
    const record: TaskOutcome = {
      taskId: task.taskId,
      featureId: task.featureId,
      outcome,
      repository: task.repository,
      prNumber: task.prNumber,
      headSha: task.prHeadSha,
      mergeSha: task.mergeCommitSha,
      localSyncedSha: task.localSyncedSha,
      blockedReason: task.blockedReason,
      repairs:
        (task.lokiRepairAttempts || 0) + task.julesRepairAttempt + task.seniorGuidedRepairAttempt,
      loki: task.lokiEvidence,
      ciHeadSha: task.ciHeadSha,
      ciState: task.ciState,
      seniorHeadSha: task.reviewedHeadSha,
      seniorVerdict: task.reviewVerdict,
      archivedAt: new Date().toISOString(),
    };
    await updateDurableJson<TaskOutcome[]>(this.index(projectPath), (records) =>
      [
        ...(records || []).filter((r) => r.taskId !== task.taskId),
        redactOpenCodeEvent(record) as TaskOutcome,
      ].slice(-1000)
    );
    return redactOpenCodeEvent(record) as TaskOutcome;
  }
  async list(projectPath: string) {
    return (await readDurableJson<TaskOutcome[]>(this.index(projectPath))) || [];
  }
}

import path from 'path';
import crypto from 'crypto';
import type { ArgusProjectState, ArgusTaskState } from './types.js';
import { updateDurableJson, readDurableJson } from './durable-store.js';
import { TaskHistoryStore } from './task-history.js';
export type CampaignStatus =
  | 'running'
  | 'draining'
  | 'paused'
  | 'completed'
  | 'blocked'
  | 'expired';
export interface CampaignTaskRecord {
  taskId: string;
  started: boolean;
  completed: boolean;
  blocked: boolean;
  repairs: number;
  headSha: string | null;
  mergeSha: string | null;
  prNumber: number | null;
}
export interface ArgusCampaign {
  id: string;
  projectId: string;
  mode: 'normal' | 'overnight';
  status: CampaignStatus;
  startedAt: string;
  deadlineAt: string;
  drainAt: string;
  lastProgressAt: string;
  endedAt: string | null;
  tasksStarted: number;
  tasksCompleted: number;
  tasksBlocked: number;
  maxNewTasks: number;
  maxRepairAttempts: number;
  maxConcurrentWorkers: number;
  stopReason: string | null;
  taskRecords: CampaignTaskRecord[];
  lastMarker: string | null;
  stallCount: number;
}
export interface CampaignStart {
  mode?: 'normal' | 'overnight';
  durationMs?: number;
  drainMs?: number;
  maxNewTasks?: number;
  maxRepairAttempts?: number;
}
export interface CampaignDecision {
  exists: boolean;
  allowReconcile: boolean;
  allowNewTasks: boolean;
  nextCheckAt: string | null;
}
const ACTIVE = new Set<CampaignStatus>(['running', 'draining', 'paused']);
const bounded = (value: number | undefined, fallback: number, min: number, max: number) => {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max)
    throw new Error('CAMPAIGN_BUDGET_INVALID');
  return result;
};

/** Durable budgets and reports only. ArgusAutonomyRunner remains the sole scheduler. */
export class ArgusCampaignManager {
  constructor(
    private now = () => Date.now(),
    private history = new TaskHistoryStore()
  ) {}
  private file(projectPath: string) {
    return path.join(projectPath, '.automaker', 'campaigns', 'current.json');
  }
  async current(projectPath: string) {
    return readDurableJson<ArgusCampaign>(this.file(projectPath));
  }
  async start(projectPath: string, projectId: string, options: CampaignStart = {}) {
    const duration = bounded(options.durationMs, 8 * 3600000, 1000, 8 * 3600000);
    const drain = bounded(
      options.drainMs,
      Math.min(1800000, Math.floor(duration / 16)),
      0,
      duration
    );
    const stamp = this.now();
    return updateDurableJson<ArgusCampaign>(this.file(projectPath), (current) => {
      if (current && ACTIVE.has(current.status) && Date.parse(current.deadlineAt) > stamp)
        return current;
      return {
        id: crypto.randomUUID(),
        projectId,
        mode: options.mode === 'normal' ? 'normal' : 'overnight',
        status: 'running',
        startedAt: new Date(stamp).toISOString(),
        deadlineAt: new Date(stamp + duration).toISOString(),
        drainAt: new Date(stamp + duration - drain).toISOString(),
        lastProgressAt: new Date(stamp).toISOString(),
        endedAt: null,
        tasksStarted: 0,
        tasksCompleted: 0,
        tasksBlocked: 0,
        maxNewTasks: bounded(options.maxNewTasks, 30, 1, 100),
        maxRepairAttempts: bounded(options.maxRepairAttempts, 5, 0, 20),
        maxConcurrentWorkers: 1,
        stopReason: null,
        taskRecords: [],
        lastMarker: null,
        stallCount: 0,
      };
    });
  }
  async change(projectPath: string, action: 'pause' | 'resume' | 'stop' | 'drain') {
    const campaign = await updateDurableJson<ArgusCampaign>(this.file(projectPath), (current) => {
      if (!current) throw new Error('CAMPAIGN_NOT_FOUND');
      if (!ACTIVE.has(current.status) && !(current.status === 'blocked' && action === 'resume'))
        throw new Error('CAMPAIGN_NOT_ACTIVE');
      if (this.now() >= Date.parse(current.deadlineAt)) {
        current.status = 'expired';
        current.stopReason = 'DEADLINE_REACHED';
        current.endedAt = new Date(this.now()).toISOString();
        return current;
      }
      current.status =
        action === 'pause'
          ? 'paused'
          : action === 'drain'
            ? 'draining'
            : action === 'stop'
              ? 'completed'
              : this.now() >= Date.parse(current.drainAt)
                ? 'draining'
                : 'running';
      current.stopReason = action === 'stop' ? 'OPERATOR_STOP' : null;
      if (action === 'stop') current.endedAt = new Date(this.now()).toISOString();
      return current;
    });
    if (campaign.status === 'completed' || campaign.status === 'expired')
      await this.report(projectPath, campaign);
    return campaign;
  }
  async beforeCycle(projectPath: string, state: ArgusProjectState): Promise<CampaignDecision> {
    let current = await this.current(projectPath);
    if (!current)
      return { exists: false, allowReconcile: true, allowNewTasks: true, nextCheckAt: null };
    current = await updateDurableJson<ArgusCampaign>(this.file(projectPath), (campaign) => {
      if (!campaign) throw new Error('CAMPAIGN_NOT_FOUND');
      if (ACTIVE.has(campaign.status) && this.now() >= Date.parse(campaign.deadlineAt)) {
        campaign.status =
          state.activeTask &&
          state.activeTask.phase !== 'done' &&
          state.activeTask.phase !== 'objective-satisfied'
            ? 'expired'
            : 'completed';
        campaign.stopReason = 'DEADLINE_REACHED';
        campaign.endedAt = new Date(this.now()).toISOString();
      } else if (campaign.status === 'running' && this.now() >= Date.parse(campaign.drainAt))
        campaign.status = 'draining';
      return campaign;
    });
    if (current.status === 'completed' || current.status === 'expired')
      await this.report(projectPath, current, state);
    const allow = current.status === 'running' || current.status === 'draining';
    return {
      exists: true,
      allowReconcile: allow,
      allowNewTasks: current.status === 'running' && current.tasksStarted < current.maxNewTasks,
      nextCheckAt: ACTIVE.has(current.status)
        ? new Date(Math.min(Date.parse(current.deadlineAt), this.now() + 10000)).toISOString()
        : null,
    };
  }
  async reserveTask(projectPath: string, task: ArgusTaskState) {
    const current = await this.current(projectPath);
    if (!current) return true;
    let allowed = false;
    await updateDurableJson<ArgusCampaign>(this.file(projectPath), (campaign) => {
      if (!campaign) throw new Error('CAMPAIGN_NOT_FOUND');
      if (
        campaign.status !== 'running' ||
        this.now() >= Date.parse(campaign.drainAt) ||
        this.now() >= Date.parse(campaign.deadlineAt)
      )
        return campaign;
      const existing = campaign.taskRecords.find((r) => r.taskId === task.taskId);
      if (existing?.started) {
        allowed = true;
        return campaign;
      }
      if (campaign.tasksStarted >= campaign.maxNewTasks) return campaign;
      campaign.taskRecords.push({
        taskId: task.taskId,
        started: true,
        completed: false,
        blocked: false,
        repairs: 0,
        headSha: task.prHeadSha,
        mergeSha: null,
        prNumber: task.prNumber,
      });
      campaign.tasksStarted += 1;
      campaign.lastProgressAt = new Date(this.now()).toISOString();
      allowed = true;
      return campaign;
    });
    return allowed;
  }
  async allowRepair(projectPath: string, task: ArgusTaskState) {
    const campaign = await this.current(projectPath);
    if (!campaign) return true;
    const own =
      (task.lokiRepairAttempts || 0) + task.julesRepairAttempt + task.seniorGuidedRepairAttempt;
    const other = campaign.taskRecords
      .filter((r) => r.taskId !== task.taskId)
      .reduce((sum, r) => sum + r.repairs, 0);
    return (
      (campaign.status === 'running' || campaign.status === 'draining') &&
      this.now() < Date.parse(campaign.deadlineAt) &&
      own + other < campaign.maxRepairAttempts
    );
  }
  async observe(projectPath: string, state: ArgusProjectState) {
    if (!(await this.current(projectPath))) return;
    const past = await this.history.list(projectPath);
    const task = state.activeTask;
    const records: CampaignTaskRecord[] = past.map((t) => ({
      taskId: t.taskId,
      started: true,
      completed: t.outcome === 'completed',
      blocked: t.outcome === 'blocked',
      repairs: t.repairs,
      headSha: t.headSha,
      mergeSha: t.mergeSha,
      prNumber: t.prNumber,
    }));
    if (task)
      records.push({
        taskId: task.taskId,
        started: Boolean(
          task.julesSessionId || task.dispatchIntent || task.seniorExecutionContextId
        ),
        completed: Boolean(
          task.mergeCommitSha &&
          task.localSyncedSha &&
          ['done', 'objective-satisfied', 'objective-evaluation', 'spec-renewal'].includes(
            task.phase
          )
        ),
        blocked: task.phase === 'blocked',
        repairs:
          (task.lokiRepairAttempts || 0) + task.julesRepairAttempt + task.seniorGuidedRepairAttempt,
        headSha: task.prHeadSha,
        mergeSha: task.mergeCommitSha,
        prNumber: task.prNumber,
      });
    await updateDurableJson<ArgusCampaign>(this.file(projectPath), (campaign) => {
      if (!campaign) throw new Error('CAMPAIGN_NOT_FOUND');
      for (const record of records) {
        const found = campaign.taskRecords.find((r) => r.taskId === record.taskId);
        if (found)
          Object.assign(found, {
            ...record,
            started: found.started || record.started,
            blocked: found.blocked || record.blocked,
            completed: found.completed || record.completed,
          });
        else if (
          task?.taskId === record.taskId &&
          record.started &&
          campaign.taskRecords.length < campaign.maxNewTasks + 1
        )
          campaign.taskRecords.push(record);
      }
      campaign.tasksStarted = campaign.taskRecords.filter((r) => r.started).length;
      campaign.tasksCompleted = campaign.taskRecords.filter((r) => r.completed).length;
      campaign.tasksBlocked = campaign.taskRecords.filter((r) => r.blocked).length;
      const marker = `${state.specRevision}:${state.phase}:${task?.taskId || ''}:${task?.lastArgusEvent || ''}`;
      if (marker !== campaign.lastMarker) {
        campaign.lastMarker = marker;
        campaign.lastProgressAt = new Date(this.now()).toISOString();
        campaign.stallCount = 0;
      } else if (state.reconciliation.lastError) campaign.stallCount += 1;
      if (
        ACTIVE.has(campaign.status) &&
        (campaign.stallCount >= 3 ||
          /AUTH|PERSISTENCE|NOT_PERMITTED|EXECUTOR_UNAVAILABLE/.test(
            task?.blockedReason || state.reconciliation.lastError || ''
          ))
      ) {
        campaign.status = 'blocked';
        campaign.stopReason = 'INFRASTRUCTURE_STALL';
      }
      return campaign;
    });
  }
  private async experimentSummaries(root: string) {
    const ids =
      (await readDurableJson<string[]>(
        path.join(root, '.automaker', 'experiments', 'index.json')
      )) || [];
    return Promise.all(
      ids
        .filter((id) => /^[a-f0-9-]{36}$/.test(id))
        .slice(0, 3)
        .map((id) => readDurableJson(path.join(root, '.automaker', 'experiments', `${id}.json`)))
    );
  }
  async report(projectPath: string, campaign?: ArgusCampaign, state?: ArgusProjectState) {
    campaign ||= await this.current(projectPath);
    if (!campaign) throw new Error('CAMPAIGN_NOT_FOUND');
    const history = await this.history.list(projectPath);
    const ids = new Set(campaign.taskRecords.map((t) => t.taskId));
    const outcomes = history.filter((t) => ids.has(t.taskId));
    const report = {
      campaignId: campaign.id,
      projectId: campaign.projectId,
      status: campaign.status,
      startedAt: campaign.startedAt,
      deadlineAt: campaign.deadlineAt,
      endedAt: campaign.endedAt,
      durationMs: Math.max(
        0,
        Date.parse(campaign.endedAt || new Date(this.now()).toISOString()) -
          Date.parse(campaign.startedAt)
      ),
      tasksStarted: campaign.tasksStarted,
      tasksCompleted: campaign.tasksCompleted,
      tasksBlocked: campaign.tasksBlocked,
      prsOpened: campaign.taskRecords.filter((t) => t.prNumber).length,
      prsMerged: campaign.taskRecords.filter((t) => t.mergeSha).length,
      taskOutcomes: outcomes,
      pendingTasks: [
        ...new Set([
          ...campaign.taskRecords.filter((t) => !t.completed).map((t) => t.taskId),
          ...(state?.activeTask ? [state.activeTask.taskId] : []),
        ]),
      ],
      stopReason: campaign.stopReason,
      objectiveProgress: state
        ? { phase: state.phase, autonomy: state.autonomy, specRevision: state.specRevision }
        : null,
      experiments: await this.experimentSummaries(projectPath),
      taskRecords: campaign.taskRecords,
      activeTaskEvidence: state?.activeTask
        ? {
            taskId: state.activeTask.taskId,
            headSha: state.activeTask.prHeadSha,
            prNumber: state.activeTask.prNumber,
            loki: state.activeTask.lokiEvidence || null,
            ciState: state.activeTask.ciState,
            seniorVerdict: state.activeTask.reviewVerdict,
            repairs:
              (state.activeTask.lokiRepairAttempts || 0) +
              state.activeTask.julesRepairAttempt +
              state.activeTask.seniorGuidedRepairAttempt,
          }
        : null,
      notProven: ['Provider token/API cost accounting is unavailable unless supplied by a worker'],
      recommendedNextActions: campaign.taskRecords.some((t) => t.blocked)
        ? ['Inspect blocked task evidence before resuming']
        : ['Review verified commits and remaining objective work'],
    };
    return updateDurableJson(
      path.join(projectPath, '.automaker', 'campaigns', 'reports', `${campaign.id}.json`),
      () => report
    );
  }
}

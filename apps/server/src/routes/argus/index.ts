import { ArgusProjectAccess, ArgusAccessError } from '../../services/argus/project-access.js';
import type { SettingsService } from '../../services/settings-service.js';
import { Router } from 'express';
import type { ArgusService } from '../../services/argus/types.js';
import type { AutonomyRunnerHealth } from '../../services/argus/autonomy-runner.js';
import { argusCampaigns, getArgusAutonomyRunner } from '../../services/argus/autonomy-runtime.js';

export function createArgusRoutes(
  service: ArgusService,
  autonomyHealth?: () => Promise<AutonomyRunnerHealth | undefined>,
  settingsService?: SettingsService
): Router {
  const router = Router();
  router.get('/health', async (_req, res) =>
    res.json({ ...(await service.health()), autonomy: await autonomyHealth?.() })
  );

  const access = settingsService ? new ArgusProjectAccess(settingsService) : undefined;
  router.use(async (req, res, next) => {
    try {
      if (!access) return res.status(503).json({ error: 'ARGUS_PROJECT_ACCESS_UNAVAILABLE' });
      const projectPath = await access.resolve(req.method === 'GET' ? req.query : req.body);
      res.locals.projectPath = projectPath;
      next();
    } catch (error) {
      if (error instanceof ArgusAccessError)
        return res.status(error.status).json({ error: error.message });
      return res.status(503).json({ error: 'ARGUS_PROJECT_ACCESS_UNAVAILABLE' });
    }
  });

  for (const action of ['pause', 'resume', 'wake', 'reconcile'] as const) {
    router.post(`/${action}`, async (req, res) => {
      const projectPath = res.locals.projectPath as string;
      const state = await service.getStatus(projectPath);
      if (!state) return res.status(404).json({ error: 'Argus project not found' });
      const runner = getArgusAutonomyRunner();
      if (!runner) return res.status(503).json({ error: 'ARGUS_RUNNER_UNAVAILABLE' });
      const control = await runner.control(projectPath);
      if (
        (action === 'wake' || action === 'reconcile') &&
        ((control &&
          control.revision > control.handledRevision &&
          control.desiredAutonomy === 'paused') ||
          state.autonomy === 'paused')
      )
        return res.status(409).json({ error: 'ARGUS_PAUSED' });
      const queued = await runner.requestReconcile(
        projectPath,
        `api-${action}`,
        action === 'pause' || action === 'resume' ? action : undefined
      );
      return res.status(202).json({
        success: true,
        status: 'queued',
        requestRevision: queued.revision,
        desiredAutonomy: queued.desiredAutonomy,
      });
    });
  }

  router.get(['/campaign', '/campaign/status'], async (_req, res) => {
    const campaign = await argusCampaigns.current(res.locals.projectPath);
    return res.json({ campaign: campaign || null });
  });
  router.get('/campaign/report', async (_req, res) => {
    const projectPath = res.locals.projectPath as string;
    const campaign = await argusCampaigns.current(projectPath);
    if (!campaign) return res.status(404).json({ error: 'CAMPAIGN_NOT_FOUND' });
    return res.json(
      await argusCampaigns.report(
        projectPath,
        campaign,
        (await service.getStatus(projectPath)) || undefined
      )
    );
  });
  for (const action of ['start', 'pause', 'resume', 'stop', 'drain'] as const) {
    router.post(`/campaign/${action}`, async (req, res) => {
      const projectPath = res.locals.projectPath as string;
      const runner = getArgusAutonomyRunner();
      if (!runner) return res.status(503).json({ error: 'ARGUS_RUNNER_UNAVAILABLE' });
      const state = await service.getStatus(projectPath);
      if (!state) return res.status(404).json({ error: 'Argus project not found' });
      try {
        const campaign =
          action === 'start'
            ? await argusCampaigns.start(projectPath, state.argusProjectId, req.body.options || {})
            : await argusCampaigns.change(projectPath, action);
        await runner.requestReconcile(projectPath, `campaign-${action}`);
        return res.status(202).json({ status: 'queued', campaign });
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        return res
          .status(409)
          .json({ error: /^CAMPAIGN_[A-Z_]+$/.test(code) ? code : 'CAMPAIGN_CONTROL_FAILED' });
      }
    });
  }

  router.get('/status', async (req, res) => {
    const projectPath = res.locals.projectPath as string;
    if (!projectPath) return res.status(400).json({ error: 'projectPath is required' });
    const status = await service.getStatus(projectPath);
    if (!status) return res.status(404).json({ error: 'Argus project not found' });
    return res.json({
      enabled: status.autonomy === 'enabled',
      campaign: (await argusCampaigns.current(projectPath)) || null,
      running: status.phase !== 'error',
      argusProjectId: status.argusProjectId,
      specRevision: status.specRevision,
      phase: status.phase,
      managerStatus: status.managerStatus,
      plannerStatus: status.plannerStatus,
      objectiveStatus: status.autonomy === 'satisfied' ? 'satisfied' : 'active',
      activeTask: status.activeTask
        ? {
            taskId: status.activeTask.taskId,
            title: status.activeTask.title,
            phase: status.activeTask.phase,
            executor: status.activeTask.executor,
            julesState: status.activeTask.julesState,
            julesSessionId: status.activeTask.julesSessionId,
            prNumber: status.activeTask.prNumber,
            prUrl: status.activeTask.prUrl,
            prHeadSha: status.activeTask.prHeadSha,
            loki: status.activeTask.lokiEvidence
              ? {
                  verdict: status.activeTask.lokiEvidence.verdict,
                  headSha: status.activeTask.lokiEvidence.headSha,
                  baseSha: status.activeTask.lokiEvidence.baseSha,
                  findings: status.activeTask.lokiEvidence.findings,
                  proven: status.activeTask.lokiEvidence.proven,
                  notProven: status.activeTask.lokiEvidence.notProven,
                  attempts: status.activeTask.lokiEvidence.attempts,
                  finishedAt: status.activeTask.lokiEvidence.finishedAt,
                }
              : null,
            lokiRepairAttempts: status.activeTask.lokiRepairAttempts || 0,
            integrationEvidence: status.activeTask.integrationEvidence || null,
            ciState: status.activeTask.ciState,
            ciHeadSha: status.activeTask.ciHeadSha,
            reviewVerdict: status.activeTask.reviewVerdict,
            reviewedHeadSha: status.activeTask.reviewedHeadSha,
            mergeCommitSha: status.activeTask.mergeCommitSha,
            remoteBaseSha: status.activeTask.remoteBaseSha,
            localSyncedSha: status.activeTask.localSyncedSha,
            recoverySnapshots: status.activeTask.recoverySnapshots,
            nextAction: status.activeTask.nextAction,
            latestEvent: status.activeTask.lastArgusEvent,
            blockedReason: status.activeTask.blockedReason,
          }
        : null,
      reconciliation: status.reconciliation,
      latestStatus: status.latestStatus,
    });
  });
  return router;
}

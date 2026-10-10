import { Router } from 'express';
import type { ArgusService } from '../../services/argus/types.js';
import type { AutonomyRunnerHealth } from '../../services/argus/autonomy-runner.js';
import { getArgusAutonomyRunner } from '../../services/argus/autonomy-runtime.js';

export function createArgusRoutes(
  service: ArgusService,
  autonomyHealth?: () => Promise<AutonomyRunnerHealth | undefined>
): Router {
  const router = Router();
  router.get('/health', async (_req, res) =>
    res.json({ ...(await service.health()), autonomy: await autonomyHealth?.() })
  );

  router.post('/pause', async (req, res) => {
    const { projectPath } = req.body;
    if (!projectPath || typeof projectPath !== 'string')
      return res.status(400).json({ error: 'projectPath is required' });
    const status = await service.getStatus(projectPath);
    if (!status) return res.status(404).json({ error: 'Argus project not found' });

    const runner = getArgusAutonomyRunner();
    if (!runner) return res.status(503).json({ error: 'ARGUS_RUNNER_UNAVAILABLE' });

    status.autonomy = 'paused';
    status.reconciliation.nextAt = null;
    status.reconciliation.reason = 'api-pause';
    status.latestStatus = 'ARGUS_PAUSED_BY_API';

    const { saveArgusState } = await import('../../services/argus/project-lifecycle.js');
    await saveArgusState(projectPath, status);

    return res.json({ success: true, status: 'paused', latestStatus: status.latestStatus });
  });

  router.post('/resume', async (req, res) => {
    const { projectPath } = req.body;
    if (!projectPath || typeof projectPath !== 'string')
      return res.status(400).json({ error: 'projectPath is required' });
    const status = await service.getStatus(projectPath);
    if (!status) return res.status(404).json({ error: 'Argus project not found' });

    const runner = getArgusAutonomyRunner();
    if (!runner) return res.status(503).json({ error: 'ARGUS_RUNNER_UNAVAILABLE' });

    status.autonomy = 'enabled';
    status.reconciliation.nextAt = Date.now().toString();
    status.reconciliation.reason = 'api-resume';

    const { saveArgusState } = await import('../../services/argus/project-lifecycle.js');
    await saveArgusState(projectPath, status);

    runner.register(projectPath);
    runner.wake(projectPath, 'api-resume');

    return res.json({ success: true, status: 'enabled' });
  });

  router.post('/wake', async (req, res) => {
    const { projectPath, reason } = req.body;
    if (!projectPath || typeof projectPath !== 'string')
      return res.status(400).json({ error: 'projectPath is required' });

    const runner = getArgusAutonomyRunner();
    if (!runner) return res.status(503).json({ error: 'ARGUS_RUNNER_UNAVAILABLE' });

    const wakeReason =
      typeof reason === 'string' && reason.trim().length > 0
        ? reason.trim().substring(0, 100)
        : 'api-wake';
    runner.wake(projectPath, wakeReason);

    const status = await service.getStatus(projectPath);
    if (!status) return res.status(404).json({ error: 'Argus project not found' });

    return res.json({
      success: true,
      phase: status.phase,
      latestStatus: status.latestStatus,
      reconciliation: status.reconciliation,
    });
  });

  router.post('/reconcile', async (req, res) => {
    const { projectPath } = req.body;
    if (!projectPath || typeof projectPath !== 'string')
      return res.status(400).json({ error: 'projectPath is required' });
    const status = await service.getStatus(projectPath);
    if (!status) return res.status(404).json({ error: 'Argus project not found' });

    if (status.autonomy === 'paused') return res.status(409).json({ error: 'ARGUS_PAUSED' });

    const runner = getArgusAutonomyRunner();
    if (!runner) return res.status(503).json({ error: 'ARGUS_RUNNER_UNAVAILABLE' });

    await runner.reconcile(projectPath);
    return res.json({ success: true });
  });

  router.get('/status', async (req, res) => {
    const projectPath = typeof req.query.projectPath === 'string' ? req.query.projectPath : '';
    if (!projectPath) return res.status(400).json({ error: 'projectPath is required' });
    const status = await service.getStatus(projectPath);
    if (!status) return res.status(404).json({ error: 'Argus project not found' });
    return res.json({
      enabled: status.autonomy === 'enabled',
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

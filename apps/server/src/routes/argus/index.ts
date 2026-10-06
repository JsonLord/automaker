import { Router } from 'express';
import type { ArgusService } from '../../services/argus/types.js';
import type { AutonomyRunnerHealth } from '../../services/argus/autonomy-runner.js';

export function createArgusRoutes(
  service: ArgusService,
  autonomyHealth?: () => Promise<AutonomyRunnerHealth | undefined>
): Router {
  const router = Router();
  router.get('/health', async (_req, res) =>
    res.json({ ...(await service.health()), autonomy: await autonomyHealth?.() })
  );
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

import { Router } from 'express';
import type { ArgusService } from '../../services/argus/types.js';

export function createArgusRoutes(service: ArgusService): Router {
  const router = Router();
  router.get('/health', async (_req, res) => res.json(await service.health()));
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
      activeTask: status.activeTask,
      latestStatus: status.latestStatus,
    });
  });
  return router;
}

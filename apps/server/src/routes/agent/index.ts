import { ArgusProjectAccess } from '../../services/argus/project-access.js';
import type { SettingsService } from '../../services/settings-service.js';
import type { ArgusModeService } from '../../services/argus/modes/service.js';
/**
 * Agent routes - HTTP API for Claude agent interactions
 */

import { Router } from 'express';
import { AgentService } from '../../services/agent-service.js';
import type { EventEmitter } from '../../lib/events.js';
import { validatePathParams } from '../../middleware/validate-paths.js';
import { createStartHandler } from './routes/start.js';
import { createSendHandler } from './routes/send.js';
import { createHistoryHandler } from './routes/history.js';
import { createStopHandler } from './routes/stop.js';
import { createClearHandler } from './routes/clear.js';
import { createModelHandler } from './routes/model.js';
import { createQueueAddHandler } from './routes/queue-add.js';
import { createQueueListHandler } from './routes/queue-list.js';
import { createQueueRemoveHandler } from './routes/queue-remove.js';
import { createQueueClearHandler } from './routes/queue-clear.js';

export function createAgentRoutes(
  agentService: AgentService,
  _events: EventEmitter,
  settings?: SettingsService,
  modes?: ArgusModeService
): Router {
  const router = Router();

  router.post('/send', async (req, res, next) => {
    if (
      typeof req.body.message !== 'string' ||
      !/^\/(default|rea|paper2code|eval)(?:\s|$)/.test(req.body.message.trim())
    )
      return next();
    try {
      if (!settings || !modes) return res.status(503).json({ error: 'MODE_SERVICE_UNAVAILABLE' });
      const root = await new ArgusProjectAccess(settings).resolve({
        projectPath: req.body.workingDirectory,
      });
      return res.json({ success: true, ...(await modes.command(root, req.body.message)) });
    } catch (error) {
      const status =
        error && typeof error === 'object' && 'status' in error ? Number(error.status) : 409;
      return res.status(status).json({ error: 'MODE_SELECTION_DENIED' });
    }
  });
  router.post('/start', validatePathParams('workingDirectory?'), createStartHandler(agentService));
  router.post(
    '/send',
    validatePathParams('workingDirectory?', 'imagePaths[]'),
    createSendHandler(agentService)
  );
  router.post('/history', createHistoryHandler(agentService));
  router.post('/stop', createStopHandler(agentService));
  router.post('/clear', createClearHandler(agentService));
  router.post('/model', createModelHandler(agentService));

  // Queue routes
  router.post(
    '/queue/add',
    validatePathParams('imagePaths[]'),
    createQueueAddHandler(agentService)
  );
  router.post('/queue/list', createQueueListHandler(agentService));
  router.post('/queue/remove', createQueueRemoveHandler(agentService));
  router.post('/queue/clear', createQueueClearHandler(agentService));

  return router;
}

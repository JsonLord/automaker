/**
 * Templates routes
 * Provides API for cloning GitHub starter templates
 */

import { Router } from 'express';
import type { SettingsService } from '../../services/settings-service.js';
import { createCloneHandler } from './routes/clone.js';

export function createTemplatesRoutes(settingsService?: SettingsService): Router {
  const router = Router();

  router.post('/clone', createCloneHandler(settingsService));

  return router;
}

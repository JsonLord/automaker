import { isArgusOwned } from '../../services/argus/board-projector.js';
/**
 * Features routes - HTTP API for feature management
 */

import { Router } from 'express';
import { FeatureLoader } from '../../services/feature-loader.js';
import type { SettingsService } from '../../services/settings-service.js';
import type { AutoModeServiceCompat } from '../../services/auto-mode/index.js';
import type { EventEmitter } from '../../lib/events.js';
import { validatePathParams } from '../../middleware/validate-paths.js';
import { createListHandler } from './routes/list.js';
import { createGetHandler } from './routes/get.js';
import { createCreateHandler } from './routes/create.js';
import { createUpdateHandler } from './routes/update.js';
import { createBulkUpdateHandler } from './routes/bulk-update.js';
import { createBulkDeleteHandler } from './routes/bulk-delete.js';
import { createDeleteHandler } from './routes/delete.js';
import { createAgentOutputHandler, createRawOutputHandler } from './routes/agent-output.js';
import { createGenerateTitleHandler } from './routes/generate-title.js';
import { createExportHandler } from './routes/export.js';
import { createImportHandler, createConflictCheckHandler } from './routes/import.js';
import {
  createOrphanedListHandler,
  createOrphanedResolveHandler,
  createOrphanedBulkResolveHandler,
} from './routes/orphaned.js';

export function createFeaturesRoutes(
  featureLoader: FeatureLoader,
  settingsService?: SettingsService,
  events?: EventEmitter,
  autoModeService?: AutoModeServiceCompat
): Router {
  const router = Router();
  router.use(async (req, res, next) => {
    const mutations = [
      '/update',
      '/bulk-update',
      '/delete',
      '/bulk-delete',
      '/create',
      '/import',
      '/orphaned/resolve',
      '/orphaned/bulk-resolve',
    ];
    if (req.method !== 'POST' || !mutations.includes(req.path)) return next();
    const body = req.body || {};
    const incoming = [body.updates, body.feature, body].filter(Boolean);
    if (incoming.some(isArgusOwned))
      return res.status(409).json({ error: 'ARGUS_BOARD_IS_PROJECTION' });
    // Import can replace whole feature directories, so reserve it for non-Argus projects.
    const ids = [
      ...(Array.isArray(body.featureIds) ? body.featureIds : []),
      ...(typeof body.featureId === 'string' ? [body.featureId] : []),
      ...(typeof body.id === 'string' ? [body.id] : []),
      ...(typeof body.feature?.id === 'string' ? [body.feature.id] : []),
    ];
    if (typeof body.projectPath !== 'string') return next();
    try {
      const features =
        req.path === '/import'
          ? await featureLoader.getAll(body.projectPath)
          : await Promise.all(ids.map((id: string) => featureLoader.get(body.projectPath, id)));
      if (features.some(isArgusOwned))
        return res.status(409).json({ error: 'ARGUS_BOARD_IS_PROJECTION' });
      return next();
    } catch {
      return res.status(503).json({ error: 'FEATURE_OWNERSHIP_UNAVAILABLE' });
    }
  });

  router.post(
    '/list',
    validatePathParams('projectPath'),
    createListHandler(featureLoader, autoModeService)
  );
  router.get(
    '/list',
    validatePathParams('projectPath'),
    createListHandler(featureLoader, autoModeService)
  );
  router.post('/get', validatePathParams('projectPath'), createGetHandler(featureLoader));
  router.post(
    '/create',
    validatePathParams('projectPath'),
    createCreateHandler(featureLoader, events)
  );
  router.post(
    '/update',
    validatePathParams('projectPath'),
    createUpdateHandler(featureLoader, events)
  );
  router.post(
    '/bulk-update',
    validatePathParams('projectPath'),
    createBulkUpdateHandler(featureLoader)
  );
  router.post(
    '/bulk-delete',
    validatePathParams('projectPath'),
    createBulkDeleteHandler(featureLoader)
  );
  router.post('/delete', validatePathParams('projectPath'), createDeleteHandler(featureLoader));
  router.post('/agent-output', createAgentOutputHandler(featureLoader));
  router.post('/raw-output', createRawOutputHandler(featureLoader));
  router.post('/generate-title', createGenerateTitleHandler(settingsService));
  router.post('/export', validatePathParams('projectPath'), createExportHandler(featureLoader));
  router.post('/import', validatePathParams('projectPath'), createImportHandler(featureLoader));
  router.post(
    '/check-conflicts',
    validatePathParams('projectPath'),
    createConflictCheckHandler(featureLoader)
  );
  router.post(
    '/orphaned',
    validatePathParams('projectPath'),
    createOrphanedListHandler(featureLoader, autoModeService)
  );
  router.post(
    '/orphaned/resolve',
    validatePathParams('projectPath'),
    createOrphanedResolveHandler(featureLoader, autoModeService)
  );
  router.post(
    '/orphaned/bulk-resolve',
    validatePathParams('projectPath'),
    createOrphanedBulkResolveHandler(featureLoader)
  );

  return router;
}

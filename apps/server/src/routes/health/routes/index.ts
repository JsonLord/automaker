import { getBuildIdentity } from '../../../lib/build-identity.js';
/**
 * GET / endpoint - Basic health check
 */

import type { Request, Response } from 'express';
import { getVersion } from '../../../lib/version.js';

export function createIndexHandler() {
  return async (_req: Request, res: Response): Promise<void> => {
    const build = await getBuildIdentity();
    const opencodeStatus = build.opencode.installed ? 'available' : 'not_available';

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: getVersion(),
      opencode: opencodeStatus,
      build,
    });
  };
}

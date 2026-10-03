/**
 * GET / endpoint - Basic health check
 */

import type { Request, Response } from 'express';
import { getVersion } from '../../../lib/version.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export function createIndexHandler() {
  return async (_req: Request, res: Response): Promise<void> => {
    let opencodeStatus = 'unknown';
    try {
      await execAsync('opencode --version');
      opencodeStatus = 'available';
    } catch (err) {
      opencodeStatus = 'not_available';
    }

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: getVersion(),
      opencode: opencodeStatus,
    });
  };
}

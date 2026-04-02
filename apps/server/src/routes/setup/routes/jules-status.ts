/**
 * GET /jules-status endpoint - Get Jules CLI status
 */

import type { Request, Response } from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getJulesCliPaths, getExtendedPath, systemPathAccess } from '@automaker/platform';
import { getErrorMessage, logError } from '../common.js';

const execAsync = promisify(exec);

const execEnv = {
  ...process.env,
  PATH: getExtendedPath(),
};

export interface JulesStatus {
  installed: boolean;
  authenticated: boolean;
  version: string | null;
  path: string | null;
  user: string | null;
  error?: string;
}

async function getJulesStatus(): Promise<JulesStatus> {
  const status: JulesStatus = {
    installed: false,
    authenticated: false,
    version: null,
    path: null,
    user: null,
  };

  const isWindows = process.platform === 'win32';

  // Check if jules CLI is installed
  try {
    const findCommand = isWindows ? 'where jules' : 'command -v jules';
    const { stdout } = await execAsync(findCommand, { env: execEnv });
    status.path = stdout.trim().split(/\r?\n/)[0];
    status.installed = true;
  } catch {
    // jules not in PATH, try common locations from centralized system paths
    const commonPaths = getJulesCliPaths();

    for (const p of commonPaths) {
      try {
        if (await systemPathAccess(p)) {
          status.path = p;
          status.installed = true;
          break;
        }
      } catch {
        // Not found at this path
      }
    }
  }

  if (!status.installed) {
    return status;
  }

  // Get version
  try {
    const { stdout } = await execAsync('jules --version', { env: execEnv });
    status.version = stdout.trim();
  } catch {
    // Version command failed
  }

  // Check authentication status
  // For Jules CLI, we check if JULES_API_TOKEN is set in environment
  if (process.env.JULES_API_TOKEN) {
    status.authenticated = true;
    // Optionally try to get user info if jules supports it
    try {
      const { stdout } = await execAsync('jules whoami', { env: execEnv });
      status.user = stdout.trim();
    } catch {
      // whoami failed or not supported
    }
  } else {
    // Try jules auth status if supported
    try {
      const { stdout } = await execAsync('jules auth status', { env: execEnv });
      if (stdout.toLowerCase().includes('logged in')) {
        status.authenticated = true;
      }
    } catch {
      // Auth status returns non-zero if not authenticated
      status.authenticated = false;
    }
  }

  return status;
}

export function createJulesStatusHandler() {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      const status = await getJulesStatus();
      res.json({
        success: true,
        ...status,
      });
    } catch (error) {
      logError(error, 'Get Jules CLI status failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}

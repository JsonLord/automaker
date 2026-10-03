/**
 * GET /run-tests endpoint - Run server tests on the deployment
 */

import type { Request, Response } from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export function createRunTestsHandler() {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      // Run the server tests
      const { stdout, stderr } = await execAsync('npm run test:server', {
        cwd: process.cwd(),
      });

      res.json({
        success: true,
        stdout,
        stderr,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        stdout: (error as any).stdout,
        stderr: (error as any).stderr,
      });
    }
  };
}

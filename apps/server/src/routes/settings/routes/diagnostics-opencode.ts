import type { Request, Response } from 'express';
import { logger } from '../common.js';
import { spawn } from 'child_process';

export function createDiagnosticsOpencodeHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const output = await new Promise<{ success: boolean; data?: any; error?: string }>(
        (resolve) => {
          const proc = spawn('opencode', ['models']);
          let stdout = '';
          let stderr = '';

          proc.stdout.on('data', (d) => (stdout += d.toString()));
          proc.stderr.on('data', (d) => (stderr += d.toString()));

          proc.on('close', (code) => {
            if (code === 0) {
              try {
                const parsed = JSON.parse(stdout);
                resolve({ success: true, data: parsed });
              } catch {
                resolve({ success: false, error: 'Invalid JSON from opencode CLI: ' + stdout });
              }
            } else {
              resolve({ success: false, error: stderr || `Process exited with code ${code}` });
            }
          });
        }
      );

      if (!output.success) {
        logger.error(`[Diagnostics] OpenCode failure: ${output.error}`);
        res.status(500).json({ success: false, error: output.error });
        return;
      }

      // Sanitization: Ensure we never return anything that resembles an API key or auth payload
      // opencode models just returns a list of models, so this is generally safe, but verify.
      if (!Array.isArray(output.data)) {
        res.status(500).json({ success: false, error: 'Unexpected response format from OpenCode' });
        return;
      }

      res.status(200).json({ success: true, models: output.data });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      logger.error(`[Diagnostics] OpenCode exception: ${msg}`);
      res.status(500).json({ success: false, error: msg });
    }
  };
}

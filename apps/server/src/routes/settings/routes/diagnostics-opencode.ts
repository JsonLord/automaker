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
                // Ensure output is parsed safely
                const lines = stdout.split('\n').filter(Boolean);
                let models = [];
                for (let line of lines) {
                  try {
                    const parsed = JSON.parse(line);
                    // OpenCode models command prints JSONL of models
                    if (parsed && typeof parsed === 'object') {
                      models.push(parsed);
                    }
                  } catch {
                    continue;
                  }
                }

                resolve({ success: true, data: models });
              } catch {
                resolve({ success: false, error: 'Invalid JSON from opencode CLI: ' + stdout });
              }
            } else {
              resolve({ success: false, error: stderr || `Process exited with code ${code}` });
            }
          });

          proc.on('error', (err) => {
            resolve({ success: false, error: 'Failed to spawn opencode: ' + err.message });
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

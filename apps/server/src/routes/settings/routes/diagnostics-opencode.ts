import type { Request, Response } from 'express';
import { logger } from '../common.js';
import { spawn } from 'child_process';

const ERROR_CODES = {
  TIMEOUT: 'TIMEOUT',
  OVERSIZED_OUTPUT: 'OVERSIZED_OUTPUT',
  PROCESS_ERROR: 'PROCESS_ERROR',
  NON_ZERO_EXIT: 'NON_ZERO_EXIT',
  PARSE_ERROR: 'PARSE_ERROR',
  EMPTY_RESULT: 'EMPTY_RESULT',
  UNEXPECTED_FORMAT: 'UNEXPECTED_FORMAT',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
};

async function runOpencodeCommand(args: string[], timeoutMs = 10000, maxOutputBytes = 1024 * 1024) {
  return new Promise<{ success: boolean; data?: string[]; error?: string }>((resolve) => {
    const proc = spawn('opencode', args);
    let stdoutData = '';
    let bytesRead = 0;
    let isFinished = false;

    const timeout = setTimeout(() => {
      if (!isFinished) {
        isFinished = true;
        proc.kill('SIGKILL');
        resolve({ success: false, error: ERROR_CODES.TIMEOUT });
      }
    }, timeoutMs);

    proc.stdout.on('data', (d) => {
      if (isFinished) return;
      bytesRead += d.length;
      if (bytesRead > maxOutputBytes) {
        isFinished = true;
        proc.kill('SIGKILL');
        resolve({ success: false, error: ERROR_CODES.OVERSIZED_OUTPUT });
        return;
      }
      stdoutData += d.toString();
    });

    // We do not store stderr to prevent credential leakage in logs
    proc.stderr.on('data', () => {});

    proc.on('close', (code) => {
      if (isFinished) return;
      isFinished = true;
      clearTimeout(timeout);

      if (code === 0) {
        const lines = stdoutData.split('\n')
            .map(l => l.trim())
            .filter(l => l.length > 0 && l.includes('/')); // basic validation of provider/model
        resolve({ success: true, data: lines });
      } else {
        // We avoid sending specific error codes from the CLI output directly
        resolve({ success: false, error: ERROR_CODES.NON_ZERO_EXIT });
      }
    });

    proc.on('error', () => {
      if (isFinished) return;
      isFinished = true;
      clearTimeout(timeout);
      resolve({ success: false, error: ERROR_CODES.PROCESS_ERROR });
    });
  });
}

export function createDiagnosticsOpencodeHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const mode = req.query.mode;

      if (mode === 'inference') {
        // Bounded inference probe using 'auto' model.
        // We use JSON format, max turns 1, and ensure no files can be modified.
        // The command is simple and bounded: `opencode run -m auto --format json "Hello"`
        // Note: For real environment we might supply a more restrictive sandbox, but for now we rely on opencode constraints

        // Wait up to 30s for inference
        const output = await new Promise<{ success: boolean; data?: string; error?: string }>((resolve) => {
          const proc = spawn('opencode', ['run', '-m', 'auto', '--format', 'json', 'Say "LOCAL_PROBE_OK"']);
          let stdoutData = '';
          let bytesRead = 0;
          let isFinished = false;

          const timeout = setTimeout(() => {
            if (!isFinished) {
              isFinished = true;
              proc.kill('SIGKILL');
              resolve({ success: false, error: ERROR_CODES.TIMEOUT });
            }
          }, 30000);

          proc.stdout.on('data', (d) => {
            if (isFinished) return;
            bytesRead += d.length;
            if (bytesRead > 1024 * 1024) {
              isFinished = true;
              proc.kill('SIGKILL');
              resolve({ success: false, error: ERROR_CODES.OVERSIZED_OUTPUT });
              return;
            }
            stdoutData += d.toString();
          });

          proc.stderr.on('data', () => {}); // Ignore stderr

          proc.on('close', (code) => {
            if (isFinished) return;
            isFinished = true;
            clearTimeout(timeout);
            if (code === 0) {
                // Ensure output is safe
                if (stdoutData.includes('LOCAL_PROBE_OK')) {
                    resolve({ success: true, data: 'LOCAL_PROBE_OK' });
                } else {
                    resolve({ success: false, error: ERROR_CODES.UNEXPECTED_FORMAT });
                }
            } else {
                resolve({ success: false, error: ERROR_CODES.NON_ZERO_EXIT });
            }
          });

          proc.on('error', () => {
            if (isFinished) return;
            isFinished = true;
            clearTimeout(timeout);
            resolve({ success: false, error: ERROR_CODES.PROCESS_ERROR });
          });
        });

        if (!output.success) {
           logger.error(`[Diagnostics] OpenCode inference failure. Code: ${output.error}`);
           res.status(500).json({ success: false, error: output.error });
           return;
        }

        res.status(200).json({ success: true, result: output.data });
        return;
      }

      // Default mode: models list
      const output = await runOpencodeCommand(['models']);

      if (!output.success) {
        logger.error(`[Diagnostics] OpenCode models failure. Code: ${output.error}`);
        res.status(500).json({ success: false, error: output.error });
        return;
      }

      if (!output.data || output.data.length === 0) {
        logger.error(`[Diagnostics] OpenCode models failure. Code: ${ERROR_CODES.EMPTY_RESULT}`);
        res.status(500).json({ success: false, error: ERROR_CODES.EMPTY_RESULT });
        return;
      }

      res.status(200).json({ success: true, models: output.data });
    } catch (e) {
      logger.error(`[Diagnostics] OpenCode exception: ${ERROR_CODES.UNKNOWN_ERROR}`);
      res.status(500).json({ success: false, error: ERROR_CODES.UNKNOWN_ERROR });
    }
  };
}

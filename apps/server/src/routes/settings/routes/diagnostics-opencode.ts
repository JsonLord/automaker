import type { Request, Response } from 'express';
import { logger } from '../common.js';
import { spawn } from 'child_process';
import type { SettingsService } from '../../../services/settings-service.js';

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

    proc.stderr.on('data', () => {});

    proc.on('close', (code) => {
      if (isFinished) return;
      isFinished = true;
      clearTimeout(timeout);

      if (code === 0) {
        const lines = stdoutData
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && l.includes('/'));
        resolve({ success: true, data: lines });
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
}

export function createDiagnosticsOpencodeHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    try {
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

export function createDiagnosticsOpencodeInferenceHandler(settingsService: SettingsService) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      // 1. Resolve configured model instead of hardcoded 'auto'
      const globalSettings = await settingsService.getGlobalSettings();
      let configuredModel =
        process.env.COMPATIBLE_MODEL ||
        globalSettings.phaseModels?.enhancementModel?.model ||
        'auto';

      // Map 'automaker-compatible/xyz' to OpenCode format or pass directly
      if (configuredModel.startsWith('automaker-compatible/')) {
        configuredModel = configuredModel.replace('automaker-compatible/', '');
      }
      if (configuredModel === 'automaker-compatible') {
        configuredModel = 'auto';
      }

      const output = await new Promise<{ success: boolean; data?: string; error?: string }>(
        (resolve) => {
          // Enforce isolated working directory, no file modifications, json format
          const proc = spawn(
            'opencode',
            ['run', '-m', configuredModel, '--format', 'json', 'Say "LOCAL_PROBE_OK"'],
            {
              cwd: '/tmp', // Isolated working directory
            }
          );

          let stdoutData = '';
          let bytesRead = 0;
          let isFinished = false;

          const timeout = setTimeout(() => {
            if (!isFinished) {
              isFinished = true;
              proc.kill('SIGKILL');
              resolve({ success: false, error: ERROR_CODES.TIMEOUT });
            }
          }, 45000); // Wait up to 45s for inference

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

          proc.stderr.on('data', () => {});

          proc.on('close', (code) => {
            if (isFinished) return;
            isFinished = true;
            clearTimeout(timeout);
            if (code === 0) {
              // Parse JSON event safely rather than arbitrary text searching
              try {
                const events = stdoutData
                  .split('\n')
                  .filter((l) => l.trim().length > 0)
                  .map((l) => JSON.parse(l));
                const assistantResponse = events.find(
                  (e) => e.type === 'assistant_message' && e.content
                );

                if (assistantResponse && assistantResponse.content.includes('LOCAL_PROBE_OK')) {
                  resolve({ success: true, data: 'LOCAL_PROBE_OK' });
                } else {
                  resolve({ success: false, error: ERROR_CODES.UNEXPECTED_FORMAT });
                }
              } catch (e) {
                resolve({ success: false, error: ERROR_CODES.PARSE_ERROR });
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
        }
      );

      if (!output.success) {
        logger.error(`[Diagnostics] OpenCode inference failure. Code: ${output.error}`);
        res.status(500).json({ success: false, error: output.error });
        return;
      }

      res.status(200).json({ success: true, result: output.data });
    } catch (e) {
      logger.error(`[Diagnostics] OpenCode exception: ${ERROR_CODES.UNKNOWN_ERROR}`);
      res.status(500).json({ success: false, error: ERROR_CODES.UNKNOWN_ERROR });
    }
  };
}

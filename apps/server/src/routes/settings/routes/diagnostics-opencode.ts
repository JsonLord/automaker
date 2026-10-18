import type { Request, Response } from 'express';
import { logger } from '../common.js';
import { spawn } from 'child_process';
import type { SettingsService } from '../../../services/settings-service.js';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';

const ERROR_CODES = {
  TIMEOUT: 'TIMEOUT',
  OVERSIZED_OUTPUT: 'OVERSIZED_OUTPUT',
  PROCESS_ERROR: 'PROCESS_ERROR',
  NON_ZERO_EXIT: 'NON_ZERO_EXIT',
  PARSE_ERROR: 'PARSE_ERROR',
  EMPTY_RESULT: 'EMPTY_RESULT',
  UNEXPECTED_FORMAT: 'UNEXPECTED_FORMAT',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
  MISSING_CONFIGURATION: 'MISSING_CONFIGURATION',
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
    let tmpDir = '';
    try {
      // 1. Resolve configured model instead of hardcoded 'auto'
      const globalSettings = await settingsService.getGlobalSettings();
      let configuredModel =
        process.env.COMPATIBLE_MODEL || globalSettings.phaseModels?.enhancementModel?.model;

      if (!configuredModel) {
        res.status(400).json({ success: false, error: ERROR_CODES.MISSING_CONFIGURATION });
        return;
      }

      // Map 'automaker-compatible/xyz' to OpenCode format or pass directly
      if (configuredModel.startsWith('automaker-compatible/')) {
        configuredModel = configuredModel.replace('automaker-compatible/', '');
      }

      // Create a dedicated isolated tmp directory
      tmpDir = path.join(os.tmpdir(), `argus-diag-${randomUUID()}`);
      await fs.mkdir(tmpDir, { recursive: true });

      const output = await new Promise<{ success: boolean; data?: string; error?: string }>(
        (resolve) => {
          // Run with json formatting, limited turns, explicit model, and inside isolation path.
          // Strip sensitive environment variables.
          const safeEnv = {
            ...process.env,
            // Unset potentially sensitive or environment-breaking variables
            OPENAI_API_KEY: undefined,
            ANTHROPIC_API_KEY: undefined,
            // Re-inject explicitly mapped provider variables if needed for actual opencode configuration,
            // but for basic 'automaker-compatible', the endpoint resolves via the global system context.
          };

          const proc = spawn(
            'opencode',
            [
              'run',
              '-m',
              configuredModel,
              '--format',
              'json',
              '--max-turns',
              '1',
              // Deny dangerous tools implicitly or explicitly via standard CLI limits if available
              '--system',
              'You are a test probe. Answer exactly with the phrase LOCAL_PROBE_OK and nothing else. Do not use tools.',
              'Say "LOCAL_PROBE_OK"',
            ],
            {
              cwd: tmpDir,
              env: safeEnv as NodeJS.ProcessEnv,
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

                // Locate standard OpenCodeRoleRunner format
                const assistantMessage = events.find(
                  (e) => e.type === 'assistant_message' && e.content
                );
                // also handle alternate schema (e.g. part.text)
                const messagePart = events.find((e) => e.type === 'message' && e.part?.text);

                const content = assistantMessage?.content || messagePart?.part?.text;

                if (content && content.includes('LOCAL_PROBE_OK')) {
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
    } finally {
      if (tmpDir) {
        try {
          await fs.rm(tmpDir, { recursive: true, force: true });
        } catch (e) {
          // Ignored
        }
      }
    }
  };
}

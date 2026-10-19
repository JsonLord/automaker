import type { Request, Response } from 'express';
import { logger } from '../common.js';
import { spawn } from 'child_process';
import type { SettingsService } from '../../../services/settings-service.js';
import { OpenCodeRoleRunner } from '../../../services/argus/opencode-role-runner.js';
import { resolveOpenCodeModel } from '@automaker/model-resolver';

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

// A probe consumes inference quota; reject concurrent requests rather than queueing them.
let inferenceActive = false;
export function createDiagnosticsOpencodeInferenceHandler(settingsService: SettingsService) {
  return async (_req: Request, res: Response): Promise<void> => {
    if (inferenceActive) {
      res.status(429).json({ success: false, error: 'INFERENCE_BUSY' });
      return;
    }
    inferenceActive = true;
    try {
      const settings = await settingsService.getGlobalSettings();
      const configured =
        process.env.COMPATIBLE_MODEL || settings.phaseModels?.enhancementModel?.model;
      if (!configured) {
        res.status(400).json({ success: false, error: ERROR_CODES.MISSING_CONFIGURATION });
        return;
      }
      const model = resolveOpenCodeModel(
        configured,
        process.env.COMPATIBLE_MODEL ? 'automaker-compatible' : undefined
      ).id;
      const output = await OpenCodeRoleRunner.probe(model);
      res.status(200).json({ success: true, ...output });
    } catch {
      // Provider errors may contain credentials or private endpoints. Never echo raw subprocess output.
      res.status(503).json({ success: false, error: 'OPENCODE_INFERENCE_FAILED' });
    } finally {
      inferenceActive = false;
    }
  };
}

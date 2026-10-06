import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { configureOpenCode, upsertCompatibleProvider, AUTOMAKER_PROVIDER_ID } from '../../../src/services/argus/opencode-config.js';
import { createOpencodeStatusHandler } from '../../../src/routes/setup/routes/opencode-status.js';
import type { Request, Response } from 'express';

describe('OpenCode Managed Configuration & Status Handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('upsertCompatibleProvider & configureOpenCode secret masking', () => {
    it('should use {env:COMPATIBLE_API_KEY} reference and not literal secret in config', () => {
      const current = {};
      const url = 'https://api.example.com/v1';
      const model = 'glm-4.7';

      const next = upsertCompatibleProvider(current, url, model) as Record<string, any>;

      expect(next.provider[AUTOMAKER_PROVIDER_ID]).toBeDefined();
      expect(next.provider[AUTOMAKER_PROVIDER_ID].options.baseURL).toBe(url);
      expect(next.provider[AUTOMAKER_PROVIDER_ID].options.apiKey).toBe('{env:COMPATIBLE_API_KEY}');

      // Confirm literal secret is NOT present in generated config object
      const jsonString = JSON.stringify(next);
      expect(jsonString).not.toContain('my-super-secret-key-999');
    });

    it('should write config file using environment variable reference', async () => {
      const tempDir = path.join(os.tmpdir(), `opencode-test-${Date.now()}`);
      process.env.COMPATIBLE_URL = 'https://api.example.com/v1';
      process.env.COMPATIBLE_MODEL = 'glm-4.7';
      process.env.COMPATIBLE_API_KEY = 'my-super-secret-key-999';

      const result = await configureOpenCode(process.env, tempDir);

      expect(result).toBe('automaker-compatible/glm-4.7');

      const configPath = path.join(tempDir, 'opencode.json');
      const content = await fs.readFile(configPath, 'utf8');

      expect(content).toContain('"apiKey": "{env:COMPATIBLE_API_KEY}"');
      expect(content).not.toContain('my-super-secret-key-999');

      await fs.rm(tempDir, { recursive: true, force: true });
    });
  });

  describe('createOpencodeStatusHandler', () => {
    it('should never expose COMPATIBLE_API_KEY in status response', async () => {
      process.env.COMPATIBLE_URL = 'https://api.example.com/v1';
      process.env.COMPATIBLE_MODEL = 'glm-4.7';
      process.env.COMPATIBLE_API_KEY = 'my-super-secret-key-999';

      const handler = createOpencodeStatusHandler();

      const req = {} as Request;
      let jsonResult: any = null;
      const res = {
        json: (data: any) => {
          jsonResult = data;
          return res;
        },
        status: () => res,
      } as unknown as Response;

      await handler(req, res);

      expect(jsonResult).toBeDefined();
      expect(jsonResult.success).toBe(true);
      expect(jsonResult.authMode).toBe('compatible-provider');
      expect(jsonResult.provider).toBe('automaker-compatible');
      expect(jsonResult.model).toBe('glm-4.7');

      // Crucial security assertion: secret must never be exposed
      const responseStr = JSON.stringify(jsonResult);
      expect(responseStr).not.toContain('my-super-secret-key-999');
    });
  });
});

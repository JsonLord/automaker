import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createDiagnosticsOpencodeHandler,
  createDiagnosticsOpencodeInferenceHandler,
} from '../../../../src/routes/settings/routes/diagnostics-opencode.js';
import { OpenCodeRoleRunner } from '../../../../src/services/argus/opencode-role-runner.js';
import type { Request, Response } from 'express';
import { spawn } from 'child_process';
import { spawnProcess } from '@automaker/platform';
import EventEmitter from 'events';
import fs from 'fs/promises';
import type { SettingsService } from '../../../../src/services/settings-service.js';

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn: vi.fn(),
}));
vi.mock('@automaker/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@automaker/platform')>()),
  spawnProcess: vi.fn(),
}));
const event = (value: unknown) => JSON.stringify(value) + '\n';
const text = event({ type: 'text', part: { text: 'LOCAL_PROBE_OK' } });
describe('OpenCode diagnostic contract', () => {
  let json: ReturnType<typeof vi.fn>;
  let status: ReturnType<typeof vi.fn>;
  let settings: SettingsService;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('COMPATIBLE_MODEL', 'vendor/model');
    vi.stubEnv('COMPATIBLE_URL', 'https://provider.invalid/v1');
    vi.stubEnv('COMPATIBLE_API_KEY', 'provider-fixture');
    json = vi.fn();
    status = vi.fn().mockReturnValue({ json });
    settings = {
      getGlobalSettings: vi.fn().mockResolvedValue({
        phaseModels: { enhancementModel: { model: 'automaker-compatible/vendor/model' } },
      }),
    } as unknown as SettingsService;
    vi.mocked(spawnProcess).mockResolvedValue({ stdout: text, stderr: '', exitCode: 0 });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });
  const invoke = () =>
    createDiagnosticsOpencodeInferenceHandler(settings)(
      {} as Request,
      { status } as unknown as Response
    );
  it('lists models', async () => {
    const proc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValueOnce(proc as any);
    const pending = createDiagnosticsOpencodeHandler()(
      {} as Request,
      { status } as unknown as Response
    );
    proc.stdout.emit('data', 'provider/model\n');
    proc.emit('close', 0);
    await pending;
    expect(json).toHaveBeenCalledWith({ success: true, models: ['provider/model'] });
  });
  it('fails missing configuration', async () => {
    vi.stubEnv('COMPATIBLE_MODEL', '');
    vi.mocked(settings.getGlobalSettings).mockResolvedValue({} as any);
    await invoke();
    expect(status).toHaveBeenCalledWith(400);
    expect(spawnProcess).not.toHaveBeenCalled();
  });
  it('preserves provider/model, isolates configuration and excludes unrelated credentials', async () => {
    vi.stubEnv('GITHUB_PAT', 'github-secret');
    vi.stubEnv('JULES_API_KEY', 'jules-secret');
    vi.stubEnv('HF_TOKEN', 'hf-secret');
    vi.stubEnv('OPENCODE_CONFIG', '/untrusted/config.json');
    vi.mocked(spawnProcess).mockImplementation(async (options) => {
      expect(options.inheritEnv).toBe(false);
      expect(options.args).toEqual([
        'run',
        '--pure',
        '--title',
        'Argus inference probe',
        '--model',
        'automaker-compatible/vendor/model',
        '--format',
        'json',
      ]);
      expect(options.env).toMatchObject({
        OPENCODE_PERMISSION: '{"*":"deny"}',
        OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
        COMPATIBLE_API_KEY: 'provider-fixture',
      });
      expect(options.env).not.toHaveProperty('GITHUB_PAT');
      expect(options.env).not.toHaveProperty('JULES_API_KEY');
      expect(options.env).not.toHaveProperty('HF_TOKEN');
      expect(options.env?.OPENCODE_CONFIG).not.toBe('/untrusted/config.json');
      const config = JSON.parse(await fs.readFile(options.env!.OPENCODE_CONFIG, 'utf8'));
      expect(config).toMatchObject({
        permission: { '*': 'deny' },
        plugin: [],
        instructions: [],
        provider: { 'automaker-compatible': { models: { 'vendor/model': {} } } },
      });
      expect(config.provider['automaker-compatible'].options.apiKey).toBe(
        '{env:COMPATIBLE_API_KEY}'
      );
      expect(await fs.readdir(options.cwd)).toEqual([]);
      return { stdout: text, stderr: '', exitCode: 0 };
    });
    await invoke();
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({
      success: true,
      result: 'LOCAL_PROBE_OK',
      model: 'automaker-compatible/vendor/model',
    });
    const sandbox = vi.mocked(spawnProcess).mock.calls[0][0].env!.HOME;
    await expect(fs.stat(sandbox)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each([
    event({ type: 'assistant_message', content: 'LOCAL_PROBE_OK' }),
    event({ type: 'message', part: { text: 'LOCAL_PROBE_OK' } }),
    text + event({ type: 'error', error: { data: { message: 'secret provider failure' } } }),
    text + event({ type: 'step_finish', part: { reason: 'error' } }),
    text + event({ type: 'tool_use', name: 'read' }),
    event({ type: 'text', part: { text: 'prefix LOCAL_PROBE_OK suffix' } }),
  ])('rejects fabricated text, terminal failure or tool events', async (stdout) => {
    vi.mocked(spawnProcess).mockResolvedValue({ stdout, stderr: '', exitCode: 0 });
    await invoke();
    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({ success: false, error: 'OPENCODE_INFERENCE_FAILED' });
  });
  it('rejects a nonzero exit even with genuine text', async () => {
    vi.mocked(spawnProcess).mockResolvedValue({ stdout: text, stderr: 'private', exitCode: 1 });
    await invoke();
    expect(status).toHaveBeenCalledWith(503);
  });
  it('bounds concurrency and releases it after failure', async () => {
    let finish!: () => void;
    vi.mocked(spawnProcess).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ stdout: text, stderr: '', exitCode: 0 });
        })
    );
    const pending = invoke();
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1));
    await invoke();
    expect(status).toHaveBeenCalledWith(429);
    finish();
    await pending;
    await invoke();
    expect(status).toHaveBeenLastCalledWith(200);
  });
  it('aborts the CLI within 45 seconds and bounds output', async () => {
    vi.useFakeTimers();
    vi.mocked(spawnProcess).mockImplementationOnce(
      (options) =>
        new Promise((_resolve, reject) => {
          expect(options.maxOutputBytes).toBe(65536);
          options.abortController!.signal.addEventListener('abort', () =>
            reject(new Error('timeout'))
          );
        })
    );
    // Test the shared subprocess contract directly without asynchronous filesystem setup.
    const pending = OpenCodeRoleRunner.invokeCli({
      role: 'diagnostic',
      contextId: 'timeout',
      model: 'opencode/test',
      prompt: 'probe',
      cwd: '/tmp',
      readOnly: true,
      timeoutMs: 45000,
    });
    const assertion = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(45000);
    await assertion;
  });
});

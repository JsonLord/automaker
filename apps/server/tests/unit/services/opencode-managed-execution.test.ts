import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { spawnProcess } from '@automaker/platform';
import { AgentExecutor } from '../../../src/services/agent-executor.js';
import { OpencodeProvider } from '../../../src/providers/opencode-provider.js';
import { SettingsService } from '../../../src/services/settings-service.js';
import { resolveProviderContext } from '../../../src/lib/settings-helpers.js';
import { SupervisedArgusService } from '../../../src/services/argus/argus-service.js';
import { configureOpenCode } from '../../../src/services/argus/opencode-config.js';
import { OpenCodeRoleRunner } from '../../../src/services/argus/opencode-role-runner.js';
import { resolvePhaseModel } from '@automaker/model-resolver';
import { openCodeFailure, sanitizeOpenCodeOutput } from '../../../src/lib/opencode-errors.js';

vi.mock('@automaker/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@automaker/platform')>()),
  spawnProcess: vi.fn(),
}));

const dirs: string[] = [];
async function temp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-opencode-'));
  dirs.push(dir);
  return dir;
}
function managedEnv() {
  vi.stubEnv('COMPATIBLE_URL', 'https://example.test/v1');
  vi.stubEnv('COMPATIBLE_MODEL', 'MiniMax-M2.7');
  vi.stubEnv('COMPATIBLE_API_KEY', 'fixture-secret-do-not-persist');
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('managed OpenCode execution regression', () => {
  it('retains the selected phase identity through SettingsHelper, AgentExecutor and CLI arguments', async () => {
    managedEnv();
    const dir = await temp();
    const settings = new SettingsService(dir);
    const phase = resolvePhaseModel({ model: 'MiniMax-M2.7', providerId: 'automaker-compatible' });
    const context = await resolveProviderContext(settings, phase.model, phase.providerId);
    const provider = new OpencodeProvider();
    const captured: string[][] = [];
    vi.spyOn(provider, 'executeQuery').mockImplementation(async function* (options) {
      captured.push(provider.buildCliArgs(options));
      yield {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'bounded result' }] },
      };
      yield { type: 'result', subtype: 'success' };
    });
    const executor = new AgentExecutor(
      { emitAutoModeEvent: vi.fn() } as any,
      { saveFeatureSummary: vi.fn(), updateFeaturePlanSpec: vi.fn() } as any,
      { waitForApproval: vi.fn() } as any
    );
    await executor.execute(
      {
        workDir: dir,
        projectPath: dir,
        featureId: 'production-model',
        prompt: 'Return a greeting',
        abortController: new AbortController(),
        provider,
        planningMode: 'skip',
        effectiveBareModel: 'MiniMax-M2.7',
        model: phase.model,
        sdkOptions: { model: context.resolvedModel, maxTurns: 1 },
      },
      {
        waitForApproval: vi.fn(),
        saveFeatureSummary: vi.fn(),
        updateFeatureSummary: vi.fn(),
        buildTaskPrompt: vi.fn(),
      }
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain('automaker-compatible/MiniMax-M2.7');
    expect(captured[0]).not.toContain('opencode/MiniMax-M2.7');
    const nativePhase = resolvePhaseModel({ model: 'MiniMax-M2.7', providerId: 'opencode' });
    const nativeContext = await resolveProviderContext(
      settings,
      nativePhase.model,
      nativePhase.providerId
    );
    await executor.execute(
      {
        workDir: dir,
        projectPath: dir,
        featureId: 'native-model',
        prompt: 'Return a greeting',
        abortController: new AbortController(),
        provider,
        planningMode: 'skip',
        effectiveBareModel: 'MiniMax-M2.7',
        model: nativePhase.model,
        sdkOptions: { model: nativeContext.resolvedModel, maxTurns: 1 },
      },
      {
        waitForApproval: vi.fn(),
        saveFeatureSummary: vi.fn(),
        updateFeatureSummary: vi.fn(),
        buildTaskPrompt: vi.fn(),
      }
    );
    expect(captured[1]).toContain('opencode/MiniMax-M2.7');
    expect(captured[1]).not.toContain('automaker-compatible/MiniMax-M2.7');

    const roles: string[] = [];
    const runner = new OpenCodeRoleRunner(undefined, async (input) => {
      roles.push(input.model);
      return input.role === 'diagnostic'
        ? JSON.stringify({
            rootCause: 'routing',
            recommendedFix: 'canonical identity',
            juniorCanRepair: true,
            evidence: [],
            filesLikelyAffected: [],
          })
        : input.role === 'reviewer'
          ? JSON.stringify({
              verdict: 'approve',
              reviewedHeadSha: 'abc',
              findings: [],
              requiredChanges: [],
              evidence: [],
            })
          : 'bounded result';
    });
    await runner.diagnose({});
    await runner.review({});
    await runner.execute('bounded task', dir);
    expect(roles).toEqual(Array(3).fill('automaker-compatible/MiniMax-M2.7'));
  });

  it('uses the same structured provider/model for Manager and Planner and preserves native bridge configuration', async () => {
    managedEnv();
    vi.stubEnv('ARGUS_BRIDGE_FAKE', '1');
    vi.stubEnv('DATA_DIR', await temp());
    const service = new SupervisedArgusService(path.resolve('scripts/argus_runtime_bridge.py'));
    try {
      await service.start();
      expect(await service.health()).toMatchObject({
        provider: 'automaker-compatible',
        model: 'MiniMax-M2.7',
        roleBackends: {
          MANAGER: 'opencode',
          PLANNER: 'opencode',
          ENGINEER: 'opencode',
          REVIEWER: 'opencode',
        },
      });
    } finally {
      await service.stop();
    }
    vi.stubEnv('COMPATIBLE_URL', undefined);
    vi.stubEnv('COMPATIBLE_MODEL', undefined);
    vi.stubEnv('COMPATIBLE_API_KEY', undefined);
    vi.stubEnv('ARGUS_SKILL_OPENCODE_PROVIDER', 'opencode');
    vi.stubEnv('ARGUS_SKILL_MODEL', 'big-pickle');
    const native = new SupervisedArgusService(path.resolve('scripts/argus_runtime_bridge.py'));
    try {
      await native.start();
      expect(await native.health()).toMatchObject({ provider: 'opencode', model: 'big-pickle' });
    } finally {
      await native.stop();
    }
  });

  it('decodes real CLI JSONL role text and sanitizes subprocess failures', async () => {
    managedEnv();
    const review = {
      verdict: 'approve',
      reviewedHeadSha: 'abc',
      findings: [],
      requiredChanges: [],
      evidence: [],
    };
    vi.mocked(spawnProcess).mockResolvedValue({
      exitCode: 0,
      stderr: '',
      stdout: [
        JSON.stringify({ type: 'step_start', sessionID: 'role-session' }),
        JSON.stringify({
          type: 'text',
          sessionID: 'role-session',
          part: { text: JSON.stringify(review) },
        }),
        JSON.stringify({
          type: 'step_finish',
          sessionID: 'role-session',
          part: { reason: 'stop' },
        }),
      ].join('\n'),
    });
    const result = await new OpenCodeRoleRunner().review({ evidence: 'bounded fixture' });
    expect(result.result).toEqual(review);
    expect(spawnProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['run', '--model', 'automaker-compatible/MiniMax-M2.7', '--format', 'json'],
        stdinData: expect.stringContaining('bounded fixture'),
        maxOutputBytes: 65536,
      })
    );
    vi.mocked(spawnProcess).mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: `Unexpected server error ${process.env.COMPATIBLE_API_KEY}`,
    });
    await expect(new OpenCodeRoleRunner().execute('bounded task', await temp())).rejects.toThrow(
      'OPENCODE_COMPATIBLE_PROVIDER_FAILED'
    );
    await expect(
      new OpenCodeRoleRunner().execute('bounded task', await temp())
    ).rejects.not.toThrow(process.env.COMPATIBLE_API_KEY!);
  });

  it('migrates bare phase/profile settings on restart and removes the generated inline secret profile', async () => {
    managedEnv();
    const dir = await temp();
    await fs.writeFile(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        version: 6,
        phaseModels: {
          specGenerationModel: {
            model: 'MiniMax-M2.7',
            providerId: 'automaker-compatible-provider',
          },
        },
        defaultFeatureModel: { model: 'MiniMax-M2.7' },
        profiles: [{ model: 'MiniMax-M2.7', providerId: 'automaker-compatible' }],
        claudeCompatibleProviders: [
          { id: 'automaker-compatible-provider', apiKey: 'old-generated-credential', models: [] },
          { id: 'user-provider', enabled: true, models: [] },
        ],
      })
    );
    await fs.copyFile(path.join(dir, 'settings.json'), path.join(dir, 'settings.json.bak1'));
    const settings = await new SettingsService(dir).getGlobalSettings();
    expect(settings.phaseModels.specGenerationModel).toMatchObject({
      model: 'automaker-compatible/MiniMax-M2.7',
      providerId: 'automaker-compatible',
    });
    expect(settings.defaultFeatureModel.model).toBe('automaker-compatible/MiniMax-M2.7');
    const persisted = await fs.readFile(path.join(dir, 'settings.json'), 'utf8');
    expect(persisted).not.toContain('old-generated-credential');
    expect(await fs.readFile(path.join(dir, 'settings.json.bak1'), 'utf8')).not.toContain(
      'old-generated-credential'
    );
    expect(persisted).not.toContain(process.env.COMPATIBLE_API_KEY);
    expect(persisted).toContain('user-provider');
    expect((await new SettingsService(dir).getGlobalSettings()).defaultFeatureModel).toEqual(
      settings.defaultFeatureModel
    );
  });

  it('the deployed Python startup preserves unrelated providers and never stores the environment key', async () => {
    managedEnv();
    const dir = await temp();
    await fs.writeFile(
      path.join(dir, 'settings.json'),
      JSON.stringify({ claudeCompatibleProviders: [{ id: 'keep' }] })
    );
    execFileSync('python3', ['update_settings.py', dir, 'MiniMax-M2.7'], {
      cwd: process.cwd(),
      stdio: 'pipe',
    });
    const contents = await fs.readFile(path.join(dir, 'settings.json'), 'utf8');
    expect(contents).not.toContain(process.env.COMPATIBLE_API_KEY);
    expect(JSON.parse(contents).phaseModels.specGenerationModel).toEqual({
      model: 'automaker-compatible/MiniMax-M2.7',
      providerId: 'automaker-compatible',
    });
    expect(contents).toContain('keep');
  });

  it('validates missing requirements and uses an environment reference in OpenCode config', async () => {
    const dir = await temp();
    await expect(configureOpenCode({ COMPATIBLE_MODEL: 'MiniMax-M2.7' }, dir)).rejects.toThrow(
      'COMPATIBLE_URL, COMPATIBLE_API_KEY'
    );
    const env = {
      COMPATIBLE_URL: 'https://example.test/v1',
      COMPATIBLE_MODEL: 'MiniMax-M2.7',
      COMPATIBLE_API_KEY: 'fixture-secret-do-not-persist',
    };
    expect(await configureOpenCode(env, dir)).toBe('automaker-compatible/MiniMax-M2.7');
    const contents = await fs.readFile(path.join(dir, 'opencode.json'), 'utf8');
    expect(contents).toContain('{env:COMPATIBLE_API_KEY}');
    expect(contents).not.toContain(env.COMPATIBLE_API_KEY);
    expect(
      JSON.parse(contents).provider['automaker-compatible'].models['MiniMax-M2.7']
    ).toBeDefined();
  });

  it('writes the managed provider into the same XDG config directory used by the CLI', async () => {
    const dir = await temp();
    await configureOpenCode({
      XDG_CONFIG_HOME: dir,
      COMPATIBLE_URL: 'https://example.test/v1',
      COMPATIBLE_MODEL: 'MiniMax-M2.7',
      COMPATIBLE_API_KEY: 'fixture-xdg-credential',
    });
    const config = JSON.parse(
      await fs.readFile(path.join(dir, 'opencode', 'opencode.json'), 'utf8')
    );
    expect(config.provider['automaker-compatible'].models['MiniMax-M2.7']).toBeDefined();
  });

  it('bounds and sanitizes diagnostics while retaining generic failure and invocation metadata', () => {
    managedEnv();
    const error = openCodeFailure(
      `Unexpected server error. Check server logs for details. ${process.env.COMPATIBLE_API_KEY}`,
      { provider: 'automaker-compatible', model: 'MiniMax-M2.7' },
      1,
      'session-123'
    );
    expect(error).toContain('OPENCODE_COMPATIBLE_PROVIDER_FAILED');
    expect(error).toContain('Unexpected server error');
    expect(error).toContain(
      'provider=automaker-compatible, model=MiniMax-M2.7, exit=1, session=session-123'
    );
    expect(error).not.toContain(process.env.COMPATIBLE_API_KEY);
    expect(sanitizeOpenCodeOutput('x'.repeat(5000))).toHaveLength(4096);
    expect(
      openCodeFailure(
        'x'.repeat(5000),
        { provider: 'automaker-compatible', model: 'MiniMax-M2.7' },
        1
      )
    ).toContain('exit=1');
    const provider = new OpencodeProvider();
    expect(
      JSON.stringify(
        provider.normalizeEvent({ type: 'text', part: { text: process.env.COMPATIBLE_API_KEY } })
      )
    ).not.toContain(process.env.COMPATIBLE_API_KEY);
    expect(
      openCodeFailure('ProviderModelNotFoundError', { provider: 'opencode', model: 'missing' })
    ).toContain('OPENCODE_MODEL_NOT_CONFIGURED');
  });
});

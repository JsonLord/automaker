import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  configureOpenCode,
  ensureArgusControlFiles,
  migrateArgusControlFiles,
  readArgusEnvironment,
  resolveState,
  saveArgusState,
  SupervisedArgusService,
  ArgusOrchestrator,
  ArgusAutonomyRunner,
} from '../../../src/services/argus/index.js';
import { FeatureLoader } from '../../../src/services/feature-loader.js';

const dirs: string[] = [];
async function temp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'automaker-argus-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  delete process.env.ARGUS_BRIDGE_FAKE;
  delete process.env.DATA_DIR;
  delete process.env.COMPATIBLE_MODEL;
  delete process.env.COMPATIBLE_URL;
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('Argus Milestones A/B', () => {
  it('maps only strict named secrets', () => {
    const result = readArgusEnvironment({
      HF_TOKEN: 'wrong',
      JULES_API_KEY: 'j',
      COMPATIBLE_API_KEY: 'c',
      GITHUB_PAT: 'g',
    });
    expect(result).toEqual({
      compatibleUrl: undefined,
      compatibleModel: undefined,
      compatibleApiKey: 'c',
      julesApiKey: 'j',
      githubPat: 'g',
    });
  });

  it('upserts provider idempotently, preserves unrelated config, and does not serialize the secret', async () => {
    const dir = await temp();
    await fs.writeFile(
      path.join(dir, 'opencode.json'),
      JSON.stringify({ provider: { keep: { name: 'Keep' } }, theme: 'dark' })
    );
    const env = {
      COMPATIBLE_URL: 'https://models.test/v1',
      COMPATIBLE_MODEL: 'brain',
      COMPATIBLE_API_KEY: 'literal-secret',
    };
    await configureOpenCode(env, dir);
    const once = await fs.readFile(path.join(dir, 'opencode.json'), 'utf8');
    await configureOpenCode(env, dir);
    expect(await fs.readFile(path.join(dir, 'opencode.json'), 'utf8')).toBe(once);
    expect(once).toContain('keep');
    expect(once).toContain('{env:COMPATIBLE_API_KEY}');
    expect(once).not.toContain('literal-secret');
    expect((await fs.stat(path.join(dir, 'opencode.json'))).mode & 0o777).toBe(0o600);
  });

  it('creates immutable charter, campaign and deployment-disabled autonomy policy', async () => {
    const dir = await temp();
    await ensureArgusControlFiles(dir, '# campaign one', 'human objective');
    const charter = await fs.readFile(path.join(dir, 'ARGUS.md'), 'utf8');
    await ensureArgusControlFiles(dir, '# campaign two', 'rewritten objective');
    expect(await fs.readFile(path.join(dir, 'ARGUS.md'), 'utf8')).toBe(charter);
    expect(await fs.readFile(path.join(dir, 'spec.md'), 'utf8')).toBe('# campaign one');
    const policy = await fs.readFile(path.join(dir, '.automaker', 'argus.yaml'), 'utf8');
    expect(policy).toContain('enabled: true');
    expect(policy).toContain('deployment: disabled');
  });

  it('migrates spec-backed projects but leaves projects without an objective idle', async () => {
    const eligible = await temp();
    const idle = await temp();
    await fs.writeFile(path.join(eligible, 'spec.md'), '# legacy');
    expect(await migrateArgusControlFiles(eligible)).toBe(true);
    expect(await migrateArgusControlFiles(idle)).toBe(false);
    await expect(
      fs.access(path.join(eligible, '.automaker', 'argus.yaml'))
    ).resolves.toBeUndefined();
  });

  it('uses one durable identity and isolated role contexts across repeated resolution', async () => {
    const dir = await temp();
    await ensureArgusControlFiles(dir, '# spec', '# objective');
    const first = await resolveState('project-1', dir, 'brain');
    const second = await resolveState('project-1', dir, 'brain');
    expect(second.argusProjectId).toBe(first.argusProjectId);
    expect(second.specRevision).toBe(1);
    expect(second.autonomy).toBe('paused');
    expect(second.phase).toBe('planning');
    expect(new Set(Object.values(first.roles).map((role) => role.contextId)).size).toBe(4);
    expect(first.roles.reviewer.readOnly).toBe(true);
    expect(first.roles.manager.readOnly).toBe(false);
    expect(JSON.stringify(first)).not.toContain('API_KEY');
  });

  it('supervises the bridge, registers state and reports health', async () => {
    process.env.ARGUS_BRIDGE_FAKE = '1';
    const dir = await temp();
    const data = await temp();
    process.env.DATA_DIR = data;
    process.env.COMPATIBLE_MODEL = 'brain';
    process.env.COMPATIBLE_URL = 'https://models.test/v1';
    await ensureArgusControlFiles(dir, '# spec', '# objective');
    const service = new SupervisedArgusService(
      path.resolve(process.cwd(), 'scripts/argus_runtime_bridge.py')
    );
    await service.start();
    expect(await service.health()).toMatchObject({
      running: true,
      home: path.join(data, 'argus'),
      provider: 'automaker-compatible',
      model: 'brain',
      roleBackends: {
        MANAGER: 'opencode',
        PLANNER: 'opencode',
        ENGINEER: 'opencode',
        REVIEWER: 'opencode',
      },
    });
    const state = await service.createOrResolveProject({
      projectId: 'one',
      projectPath: dir,
      model: 'brain',
    });
    expect((await service.resumeProject(dir)).argusProjectId).toBe(state.argusProjectId);
    expect((await service.getStatus(dir))?.phase).toBe('planning');
    await service.stop();
    expect((await service.health()).running).toBe(false);

    const restarted = new SupervisedArgusService(
      path.resolve(process.cwd(), 'scripts/argus_runtime_bridge.py')
    );
    await restarted.start();
    const resumed = await restarted.createOrResolveProject({
      projectId: 'one',
      projectPath: dir,
      model: 'brain',
    });
    expect(resumed.argusProjectId).toBe(state.argusProjectId);
    await restarted.stop();
  });

  it('keeps new registration paused and external objective/specification changes cannot authorize work', async () => {
    process.env.ARGUS_BRIDGE_FAKE = '1';
    const dir = await temp();
    await ensureArgusControlFiles(dir, '# spec', 'objective');
    const service = new SupervisedArgusService(path.resolve('scripts/argus_runtime_bridge.py'));
    await service.start();
    try {
      const state = await service.createOrResolveProject({
        projectId: 'paused',
        projectPath: dir,
        model: 'brain',
      });
      expect(state).toMatchObject({ autonomy: 'paused', phase: 'planning', activeTask: null });
      await fs.writeFile(path.join(dir, 'spec.md'), '# externally changed spec');
      await fs.writeFile(path.join(dir, 'ARGUS.md'), '# externally changed objective');
      await service.createOrResolveProject({
        projectId: 'paused',
        projectPath: dir,
        model: 'brain',
      });
      expect(await service.getStatus(dir)).toMatchObject({
        autonomy: 'paused',
        phase: 'planning',
        activeTask: null,
      });
      const planner = { reconcileProject: vi.fn() };
      const executor = { dispatch: vi.fn(), reconcile: vi.fn() };
      const runner = new ArgusAutonomyRunner(service, planner, executor as never, undefined, {
        reconcile: vi.fn(),
      });
      runner.register(dir);
      await runner.tick();
      expect(planner.reconcileProject).not.toHaveBeenCalled();
      expect(executor.dispatch).not.toHaveBeenCalled();
      expect(executor.reconcile).not.toHaveBeenCalled();
    } finally {
      await service.stop();
    }
  });

  it.each(['native', 'persistence', 'identity'] as const)(
    'never publishes false ready state after %s failure and recovers the same identity',
    async (failure) => {
      process.env.ARGUS_BRIDGE_FAKE = '1';
      const dir = await temp();
      await ensureArgusControlFiles(dir, '# spec', 'objective');
      const service = new SupervisedArgusService(path.resolve('scripts/argus_runtime_bridge.py'));
      await service.start();
      const call = vi.spyOn(service as any, 'call');
      const originalRename = fs.rename.bind(fs);
      let stateWrites = 0;
      const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (
          String(to).endsWith('argus-state.json') &&
          ++stateWrites === 2 &&
          failure === 'persistence'
        )
          throw new Error('fixture disk failure');
        return originalRename(from, to);
      });
      if (failure === 'native') call.mockRejectedValueOnce(new Error('fixture native failure'));
      if (failure === 'identity')
        call.mockResolvedValueOnce({
          projectId: 'wrong-native',
          correlationId: 'wrong-correlation',
        });
      try {
        const input = { projectId: 'recoverable', projectPath: dir, model: 'brain' };
        await expect(service.createOrResolveProject(input)).rejects.toThrow(
          failure === 'identity' ? 'identity mismatch' : 'fixture'
        );
        expect(await service.getStatus(dir)).toBeUndefined();
        const disk = JSON.parse(
          await fs.readFile(path.join(dir, '.automaker', 'argus-state.json'), 'utf8')
        );
        expect(disk).toMatchObject({ automakerProjectId: input.projectId, autonomy: 'paused' });
        const recovered = await service.createOrResolveProject(input);
        expect(recovered.automakerProjectId).toBe(disk.automakerProjectId);
        expect(recovered.argusCorrelationId).toBe(disk.argusCorrelationId);
        expect(
          call.mock.calls
            .filter(([operation]) => operation === 'ensure_project')
            .map(([, params]) => params.projectId)
        ).toEqual([disk.argusCorrelationId, disk.argusCorrelationId]);
        expect(await service.getStatus(dir)).toBe(recovered);
        await expect(
          service.createOrResolveProject({ ...input, projectId: 'different' })
        ).rejects.toThrow('identity mismatch');
      } finally {
        rename.mockRestore();
        call.mockRestore();
        await service.stop();
      }
    }
  );

  it('runs Manager then Planner and idempotently projects one existing Kanban feature', async () => {
    const dir = await temp();
    await ensureArgusControlFiles(dir, '# bounded campaign', '# stable objective');
    process.env.ARGUS_BRIDGE_FAKE = '1';
    const service = new SupervisedArgusService(
      path.resolve(process.cwd(), 'scripts/argus_runtime_bridge.py')
    );
    await service.start();
    const firstState = await service.createOrResolveProject({
      projectId: 'brain-project',
      projectPath: dir,
      model: 'brain',
    });
    firstState.autonomy = 'enabled';
    await saveArgusState(dir, firstState);
    await service.resumeProject(dir);
    const orchestrator = new ArgusOrchestrator(service, new FeatureLoader());
    const first = await orchestrator.reconcileProject(dir);
    const second = await orchestrator.reconcileProject(dir);
    const features = await new FeatureLoader().getAll(dir);
    expect(first?.taskId).toBe('argus-task-r1');
    expect(second?.taskId).toBe(first?.taskId);
    expect(features).toHaveLength(1);
    expect((features[0].argus as { taskId: string }).taskId).toBe(first?.taskId);
    const restarted = await resolveState('brain-project', dir, 'brain');
    expect(restarted.argusProjectId).toBe(firstState.argusProjectId);
    expect(restarted.activeTask?.taskId).toBe(first?.taskId);
    await service.stop();
    delete process.env.ARGUS_BRIDGE_FAKE;
  });
});

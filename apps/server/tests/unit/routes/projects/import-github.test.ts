import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createImportGithubHandler,
  githubMetadata,
  githubRepository,
} from '../../../../src/routes/projects/routes/import-github.js';
import type { ArgusService, ArgusProjectState } from '../../../../src/services/argus/types.js';
import type { Request, Response } from 'express';
import { spawnProcess } from '@automaker/platform';
import type { SettingsService } from '../../../../src/services/settings-service.js';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

vi.mock('@automaker/platform', () => ({ spawnProcess: vi.fn() }));
const execGitCommand = vi.fn();
const sha = '1234567890abcdef1234567890abcdef12345678';
describe('GitHub import security', () => {
  let root: string;
  let service: ArgusService;
  let runner: { register: ReturnType<typeof vi.fn> } | undefined;
  let registeredState: ArgusProjectState | undefined;
  let settings: SettingsService;
  let metadata: ReturnType<typeof vi.fn>;
  let status: ReturnType<typeof vi.fn>;
  let json: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    vi.clearAllMocks();
    registeredState = undefined;
    runner = { register: vi.fn() };
    service = {
      start: vi.fn().mockResolvedValue(undefined),
      createOrResolveProject: vi.fn(async (input) => {
        registeredState = {
          automakerProjectId: input.projectId,
          argusProjectId: 'native-id',
          autonomy: 'paused',
          phase: 'planning',
        } as ArgusProjectState;
        return registeredState;
      }),
      getStatus: vi.fn(async () => registeredState),
      resumeProject: vi.fn(),
      managerHandoff: vi.fn(),
      plannerNextTask: vi.fn(),
    } as unknown as ArgusService;
    vi.mocked(spawnProcess).mockImplementation(async (options) => ({
      stdout: await execGitCommand(options.args, options.cwd, options.env, options.abortController),
      stderr: '',
      exitCode: 0,
    }));
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'import-security-'));
    vi.stubEnv('ALLOWED_ROOT_DIRECTORY', root);
    json = vi.fn();
    status = vi.fn().mockReturnValue({ json });
    settings = {
      getGlobalSettings: vi.fn().mockResolvedValue({ projects: [] }),
      updateGlobalSettings: vi.fn().mockResolvedValue({}),
    } as unknown as SettingsService;
    metadata = vi.fn(async (endpoint: string) => {
      if (endpoint.endsWith('/protection')) return { lock_branch: { enabled: false } };
      if (endpoint.includes('/rules/')) return [];
      if (endpoint.includes('/branches/'))
        return { name: 'main', commit: { sha }, protected: true };
      return {
        id: 123,
        full_name: 'JsonLord/twenty',
        clone_url: 'https://github.com/JsonLord/twenty.git',
        permissions: { push: true },
        default_branch: 'main',
      };
    });
    vi.mocked(execGitCommand).mockImplementation(async (args) => {
      if (args.includes('ls-remote'))
        return `ref: refs/heads/main\tHEAD\n${sha}\tHEAD\n${sha}\trefs/heads/main\n`;
      if (args.includes('clone')) {
        await fs.mkdir(path.join(root, 'twenty', '.git'));
        return '';
      }
      if (args.includes('rev-parse')) return sha;
      if (args.includes('symbolic-ref')) return 'main';
      if (args.includes('remote')) return 'https://github.com/JsonLord/twenty.git';
      return '';
    });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await fs.rm(root, { recursive: true, force: true });
  });
  const invoke = async (overrides = {}) => {
    await createImportGithubHandler(settings, metadata, {
      argusService: service,
      getRunner: () => runner,
    })(
      {
        body: {
          repoUrl: 'https://github.com/JsonLord/twenty',
          projectName: 'twenty',
          parentDir: root,
          ...overrides,
        },
      } as Request,
      { status } as unknown as Response
    );
  };
  it.each([
    'https://github.com.evil.test/JsonLord/twenty',
    'https://user:pass@github.com/JsonLord/twenty',
    'https://github.com:444/JsonLord/twenty',
    'https://github.com:443/JsonLord/twenty',
    'https://github.com/JsonLord/twenty/tree/main',
    'https://github.com/JsonLord/../twenty',
    'https://github.com/JsonLord/%2e%2e',
    'https://github.com/JsonLord/twenty?x=1',
    'https://github.com/JsonLord/twenty#main',
    'http://github.com/JsonLord/twenty',
    'https://github.com/JsonLord/twenty%2fother',
  ])('rejects unsafe URL %s before accessing Git', async (repoUrl) => {
    await invoke({ repoUrl });
    expect(status).toHaveBeenCalledWith(400);
    expect(execGitCommand).not.toHaveBeenCalled();
  });
  it('canonicalizes only a repository URL', () => {
    expect(githubRepository('https://github.com/JsonLord/twenty.git/')).toEqual({
      repository: 'JsonLord/twenty',
      url: 'https://github.com/JsonLord/twenty.git',
    });
  });
  it('rejects sibling prefix bypass', async () => {
    const sibling = root + '-sibling';
    await fs.mkdir(sibling);
    try {
      await invoke({ parentDir: sibling });
      expect(status).toHaveBeenCalledWith(403);
      expect(metadata).not.toHaveBeenCalled();
    } finally {
      await fs.rm(sibling, { recursive: true });
    }
  });
  it('rejects symlink escape and traversal', async () => {
    await fs.symlink(os.tmpdir(), path.join(root, 'escape'));
    await invoke({ parentDir: path.join(root, 'escape') });
    expect(status).toHaveBeenCalledWith(403);
    await invoke({ projectName: '../escape' });
    expect(status).toHaveBeenCalledWith(400);
  });
  it('rejects existing destinations including dangling symlinks', async () => {
    await fs.symlink(path.join(root, 'missing'), path.join(root, 'twenty'));
    await invoke();
    expect(status).toHaveBeenCalledWith(409);
    expect((await fs.lstat(path.join(root, 'twenty'))).isSymbolicLink()).toBe(true);
  });
  it('rejects a duplicate repository registered under another name', async () => {
    vi.mocked(settings.getGlobalSettings).mockResolvedValue({
      projects: [{ id: 'existing', path: root, name: 'existing' }],
    } as any);
    await invoke();
    expect(status).toHaveBeenCalledWith(409);
    expect(metadata).not.toHaveBeenCalled();
  });
  it('rejects an existing SSH origin for the same GitHub repository', async () => {
    vi.mocked(settings.getGlobalSettings).mockResolvedValue({
      projects: [{ id: 'existing', path: root, name: 'existing' }],
    } as any);
    execGitCommand.mockResolvedValue('git@github.com:JsonLord/twenty.git');
    await invoke();
    expect(status).toHaveBeenCalledWith(409);
    expect(metadata).not.toHaveBeenCalled();
  });
  it.each(['wrong identity', 'no push', 'archived', 'rules unavailable', 'locked branch'])(
    'rejects %s without cloning or registering',
    async (condition) => {
      const original = metadata.getMockImplementation()!;
      metadata.mockImplementation(async (endpoint) => {
        const value = await original(endpoint);
        if (condition === 'rules unavailable' && endpoint.includes('/rules/'))
          throw new Error('403');
        if (condition === 'locked branch' && endpoint.endsWith('/protection'))
          return { lock_branch: { enabled: true } };
        if (!endpoint.includes('/branches/') && !endpoint.includes('/rules/')) {
          if (condition === 'wrong identity') value.full_name = 'attacker/twenty';
          if (condition === 'no push') value.permissions.push = false;
          if (condition === 'archived') value.archived = true;
        }
        return value;
      });
      await invoke();
      expect([403, 503]).toContain(status.mock.calls[0][0]);
      expect(vi.mocked(execGitCommand).mock.calls.some(([args]) => args.includes('clone'))).toBe(
        false
      );
      expect(settings.updateGlobalSettings).not.toHaveBeenCalled();
    }
  );
  it('rejects changed remote default branch/SHA', async () => {
    vi.mocked(execGitCommand).mockResolvedValue('ref: refs/heads/other\tHEAD');
    await invoke();
    expect(status).toHaveBeenCalledWith(409);
    expect(settings.updateGlobalSettings).not.toHaveBeenCalled();
  });
  it('preserves exact history, origin, branch and registers the verified checkout', async () => {
    await invoke();
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ baseSha: sha, defaultBranch: 'main', repositoryId: 123 })
    );
    expect(settings.updateGlobalSettings).toHaveBeenCalledWith({
      projects: [expect.objectContaining({ path: path.join(root, 'twenty') })],
    });
    expect(execGitCommand).toHaveBeenCalledWith(
      expect.arrayContaining([
        'http.followRedirects=false',
        'clone',
        '--no-recurse-submodules',
        '--branch',
        'main',
      ]),
      root,
      expect.anything(),
      expect.anything()
    );
    expect(vi.mocked(execGitCommand).mock.calls.some(([args]) => args.includes('push'))).toBe(
      false
    );
  });
  it('removes its reservation on registration failure and permits a retry', async () => {
    vi.mocked(settings.updateGlobalSettings).mockRejectedValueOnce(new Error('storage failed'));
    await invoke();
    expect(status).toHaveBeenCalledWith(503);
    await expect(fs.stat(path.join(root, 'twenty'))).rejects.toMatchObject({ code: 'ENOENT' });
    await invoke();
    expect(status).toHaveBeenLastCalledWith(200);
  });
  it('fails closed if clone SHA does not match the verified remote', async () => {
    const original = vi.mocked(execGitCommand).getMockImplementation()!;
    vi.mocked(execGitCommand).mockImplementation(async (...args) =>
      args[0].includes('rev-parse') ? 'f'.repeat(40) : original(...args)
    );
    await invoke();
    expect(status).toHaveBeenCalledWith(409);
    expect(settings.updateGlobalSettings).not.toHaveBeenCalled();
  });
  it('handles missing specification without fabricating tasks', async () => {
    await invoke({ overview: 'Fix the UI' });
    expect(await fs.readFile(path.join(root, 'twenty', 'ARGUS.md'), 'utf8')).toContain(
      'Fix the UI'
    );
    await expect(fs.stat(path.join(root, 'twenty', 'spec.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('preserves existing specification and control files', async () => {
    vi.mocked(settings.getGlobalSettings).mockResolvedValue({ projects: [] });
    await invoke();
    expect(
      await fs.readFile(path.join(root, 'twenty', '.automaker', 'argus.yaml'), 'utf8')
    ).toContain('autonomy:');
    await expect(fs.stat(path.join(root, 'twenty', 'spec.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fails gracefully and sets blocked status if Argus bridge fails initialization', async () => {
    vi.mocked(service.start).mockRejectedValueOnce(new Error('Argus bridge crash'));
    await invoke();
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        importStatus: 'completed',
        argus: { status: 'blocked', code: 'ARGUS_INITIALIZATION_FAILED' },
      })
    );
  });

  it('fails gracefully and sets blocked status if autonomy runner is unavailable', async () => {
    runner = undefined;
    await invoke();
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        importStatus: 'completed',
        argus: { status: 'blocked', code: 'ARGUS_INITIALIZATION_FAILED' },
      })
    );
    // restore for subsequent tests
    runner = { register: vi.fn() };
  });

  it('fails gracefully on partial recovery errors while preserving directory', async () => {
    vi.mocked(service.getStatus).mockRejectedValueOnce(new Error('Failed verification'));
    await invoke();
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        importStatus: 'completed',
        argus: { status: 'blocked', code: 'ARGUS_INITIALIZATION_FAILED' },
      })
    );
    expect(await fs.stat(path.join(root, 'twenty'))).toBeDefined();
  });

  it('does not authorize automatic execution during registration', async () => {
    await invoke();
    const calls = runner!.register.mock.calls;
    expect(calls.length).toBe(1);
    expect(service.resumeProject).not.toHaveBeenCalled();
    expect(service.managerHandoff).not.toHaveBeenCalled();
    expect(service.plannerNextTask).not.toHaveBeenCalled();
    expect(registeredState?.autonomy).toBe('paused');
  });

  it('captures the actual generated UUID and never accepts a different identity', async () => {
    vi.mocked(service.getStatus).mockResolvedValueOnce({
      automakerProjectId: 'wrong-id',
      argusProjectId: 'native-id',
      autonomy: 'paused',
      phase: 'planning',
    } as ArgusProjectState);
    await invoke();
    const projectId = vi.mocked(service.createOrResolveProject).mock.calls[0][0].projectId;
    expect(projectId).toMatch(/^[a-f0-9-]{36}$/);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        argus: { status: 'blocked', code: 'ARGUS_INITIALIZATION_FAILED' },
      })
    );
    expect(runner!.register).not.toHaveBeenCalled();
  });

  it('does not register an unexpectedly enabled imported project with the runner', async () => {
    vi.mocked(service.getStatus).mockImplementationOnce(async () => ({
      ...registeredState!,
      autonomy: 'enabled',
    }));
    await invoke();
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ argus: { status: 'blocked', code: 'ARGUS_INITIALIZATION_FAILED' } })
    );
    expect(runner!.register).not.toHaveBeenCalled();
  });

  it('requires a real Git directory even under NODE_ENV=test', async () => {
    const original = execGitCommand.getMockImplementation()!;
    execGitCommand.mockImplementation(async (...args) =>
      args[0].includes('clone') ? '' : original(...args)
    );
    await invoke();
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ argus: { status: 'blocked', code: 'ARGUS_INITIALIZATION_FAILED' } })
    );
    expect(service.start).not.toHaveBeenCalled();
    expect(runner!.register).not.toHaveBeenCalled();
  });

  it('preserves an existing specification through successful registration', async () => {
    const original = execGitCommand.getMockImplementation()!;
    execGitCommand.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[0].includes('clone'))
        await fs.writeFile(path.join(root, 'twenty', 'spec.md'), 'repository-owned specification');
      return result;
    });
    await invoke({ overview: 'New objective' });
    expect(await fs.readFile(path.join(root, 'twenty', 'spec.md'), 'utf8')).toBe(
      'repository-owned specification'
    );
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ argus: { status: 'ready' } }));
  });

  it('retains the original registered identity after native failure; duplicate import cannot replace it', async () => {
    vi.mocked(service.createOrResolveProject).mockRejectedValueOnce(
      new Error('native registration failed')
    );
    await invoke();
    const first = json.mock.calls.at(-1)![0];
    expect(first.argus.status).toBe('blocked');
    expect(runner!.register).not.toHaveBeenCalled();
    vi.mocked(settings.getGlobalSettings).mockResolvedValue({
      projects: [{ id: first.projectId, name: 'twenty', path: first.projectPath }],
    } as any);
    await invoke();
    expect(status).toHaveBeenLastCalledWith(409);
    await service.createOrResolveProject({
      projectId: first.projectId,
      projectPath: first.projectPath,
      model: 'brain',
    });
    expect(registeredState?.automakerProjectId).toBe(first.projectId);
    expect(settings.updateGlobalSettings).toHaveBeenCalledTimes(1);
  });

  it('disallows metadata redirects instead of following renamed or transferred repositories', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal('fetch', fetchMock);
    await expect(githubMetadata('repos/JsonLord/twenty')).rejects.toThrow('authorization');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/JsonLord/twenty',
      expect.objectContaining({ redirect: 'error' })
    );
  });
});

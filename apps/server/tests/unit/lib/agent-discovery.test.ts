import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initAllowedPaths, secureFs, systemPaths } from '@automaker/platform';
import { discoverFilesystemAgents } from '../../../src/lib/agent-discovery.js';

vi.mock('@automaker/utils', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

describe('filesystem agent discovery', () => {
  let root: string;
  let home: string;
  let project: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'automaker-agent-discovery-'));
    home = path.join(root, 'user');
    project = path.join(root, 'projects', 'example');
    await fs.mkdir(project, { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.stubEnv('ALLOWED_ROOT_DIRECTORY', path.join(root, 'projects'));
    vi.stubEnv('DATA_DIR', path.join(root, 'data'));
    initAllowedPaths();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeAgent(
    source: 'user' | 'project',
    name: string,
    content: string,
    subdirectory = false
  ): Promise<string> {
    const base = source === 'user' ? home : project;
    const file = path.join(
      base,
      '.claude',
      'agents',
      ...(subdirectory ? [name, 'AGENT.md'] : [`${name}.md`])
    );
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, 'utf-8');
    return file;
  }

  function definition(description: string, prompt = 'Inspect the change carefully.'): string {
    return `---\ndescription: ${description}\n---\n${prompt}\n`;
  }

  it('returns no agents when the directories are absent or all sources are disabled', async () => {
    expect(await discoverFilesystemAgents(project)).toEqual([]);
    await writeAgent('project', 'reviewer', definition('Review code'));
    expect(await discoverFilesystemAgents(project, [])).toEqual([]);
    expect(await discoverFilesystemAgents(undefined, ['project'])).toEqual([]);
  });

  it('parses flat project definitions with mixed tool separators and a permitted model', async () => {
    const file = await writeAgent(
      'project',
      'reviewer',
      '---\nname: ignored-display-name\ndescription: Review security-sensitive code\n' +
        'tools: Read, Grep Glob,\tBash\nmodel: sonnet\n---\n\n  Review the entire diff.\n\n'
    );
    expect(await discoverFilesystemAgents(project, ['project'])).toEqual([
      {
        name: 'reviewer',
        source: 'project',
        filePath: file,
        definition: {
          description: 'Review security-sensitive code',
          tools: ['Read', 'Grep', 'Glob', 'Bash'],
          model: 'sonnet',
          prompt: 'Review the entire diff.',
        },
      },
    ]);
  });

  it('supports directory AGENT.md definitions while leaving omitted options unspecified', async () => {
    const file = await writeAgent('project', 'planner', definition('Plan bounded work'), true);
    expect(await discoverFilesystemAgents(project, ['project'])).toEqual([
      {
        name: 'planner',
        source: 'project',
        filePath: file,
        definition: {
          description: 'Plan bounded work',
          prompt: 'Inspect the change carefully.',
          tools: undefined,
          model: undefined,
        },
      },
    ]);
  });

  it.each(['sonnet', 'opus', 'haiku', 'inherit'])(
    'accepts the documented %s model',
    async (model) => {
      await writeAgent(
        'project',
        'model-check',
        `---\ndescription: Check model selection\nmodel: ${model}\n---\nUse selected model.`
      );
      const [agent] = await discoverFilesystemAgents(project, ['project']);
      expect(agent.definition.model).toBe(model);
      expect(agent.definition.prompt).toBe('Use selected model.');
    }
  );

  it('drops unsupported model values without discarding a valid prompt', async () => {
    await writeAgent(
      'project',
      'untrusted-model',
      '---\ndescription: Review code\nmodel: arbitrary_provider\n---\nKeep this prompt.'
    );
    const [agent] = await discoverFilesystemAgents(project, ['project']);
    expect(agent.definition).toEqual({
      description: 'Review code',
      prompt: 'Keep this prompt.',
      tools: undefined,
      model: undefined,
    });
  });

  it('rejects missing frontmatter or required descriptions and ignores unrelated entries', async () => {
    await writeAgent('project', 'no-frontmatter', '# This is not a definition');
    await writeAgent('project', 'no-description', '---\nmodel: sonnet\n---\nDo work.');
    await writeAgent('project', 'valid', definition('The only valid agent'));
    const agentsDirectory = path.join(project, '.claude', 'agents');
    await fs.writeFile(path.join(agentsDirectory, 'notes.txt'), definition('Ignore text files'));
    await fs.mkdir(path.join(agentsDirectory, 'empty-directory'));
    expect(
      (await discoverFilesystemAgents(project, ['project'])).map((agent) => agent.name)
    ).toEqual(['valid']);
  });

  it('preserves user/project source identity when names overlap, so callers can apply precedence', async () => {
    const userFile = await writeAgent('user', 'reviewer', definition('User-level review'));
    const projectFile = await writeAgent(
      'project',
      'reviewer',
      definition('Project-specific review')
    );
    expect(await discoverFilesystemAgents(project)).toEqual([
      {
        name: 'reviewer',
        source: 'user',
        filePath: userFile,
        definition: expect.objectContaining({ description: 'User-level review' }),
      },
      {
        name: 'reviewer',
        source: 'project',
        filePath: projectFile,
        definition: expect.objectContaining({ description: 'Project-specific review' }),
      },
    ]);
  });

  it('honors explicit source selection and does not duplicate sources listed twice', async () => {
    await writeAgent('user', 'global', definition('Global agent'));
    await writeAgent('project', 'local', definition('Local agent'));
    const userAgents = await discoverFilesystemAgents(project, ['user', 'user']);
    expect(userAgents.map((agent) => [agent.name, agent.source])).toEqual([['global', 'user']]);
    const projectAgents = await discoverFilesystemAgents(project, ['project']);
    expect(projectAgents.map((agent) => [agent.name, agent.source])).toEqual([
      ['local', 'project'],
    ]);
  });

  it('uses the system-path adapter for user agents outside the project filesystem boundary', async () => {
    const file = await writeAgent('user', 'global', definition('Global agent'), true);
    const read = vi.spyOn(systemPaths, 'systemPathReadFile');
    const agents = await discoverFilesystemAgents(undefined, ['user']);
    expect(agents).toHaveLength(1);
    expect(agents[0].filePath).toBe(file);
    expect(read).toHaveBeenCalledWith(file, 'utf-8');
    await expect(secureFs.readFile(file, 'utf-8')).rejects.toMatchObject({
      name: 'PathNotAllowedError',
    });
  });

  it('does not discover project agents from a path outside the configured root', async () => {
    const forbiddenProject = path.join(root, 'projects-sibling');
    const forbiddenDirectory = path.join(forbiddenProject, '.claude', 'agents');
    await fs.mkdir(forbiddenDirectory, { recursive: true });
    await fs.writeFile(path.join(forbiddenDirectory, 'outside.md'), definition('Must not be read'));
    expect(await discoverFilesystemAgents(forbiddenProject, ['project'])).toEqual([]);
    expect(
      await discoverFilesystemAgents(path.join(project, '..', '..', 'projects-sibling'), [
        'project',
      ])
    ).toEqual([]);
  });

  it('ignores symlink entries inside the project agent directory', async () => {
    const outsideDirectory = path.join(root, 'external-agent');
    await fs.mkdir(outsideDirectory);
    await fs.writeFile(
      path.join(outsideDirectory, 'AGENT.md'),
      definition('Untrusted external prompt')
    );
    const agentsDirectory = path.join(project, '.claude', 'agents');
    await fs.mkdir(agentsDirectory, { recursive: true });
    await fs.symlink(outsideDirectory, path.join(agentsDirectory, 'linked-directory'), 'dir');
    await fs.symlink(
      path.join(outsideDirectory, 'AGENT.md'),
      path.join(agentsDirectory, 'linked.md')
    );
    expect(await discoverFilesystemAgents(project, ['project'])).toEqual([]);
  });

  it('skips an unreadable agent while continuing to discover other definitions', async () => {
    const failedFile = await writeAgent('project', 'broken', definition('Cannot be read'));
    await writeAgent('project', 'healthy', definition('Can be read'));
    const readFile = secureFs.readFile;
    vi.spyOn(secureFs, 'readFile').mockImplementation((filePath, encoding) => {
      if (filePath === failedFile) return Promise.reject(new Error('read denied'));
      return readFile(filePath, encoding);
    });
    expect(
      (await discoverFilesystemAgents(project, ['project'])).map((agent) => agent.name)
    ).toEqual(['healthy']);
  });

  it('returns an empty source when directory enumeration fails rather than rejecting all discovery', async () => {
    await writeAgent('project', 'unreadable-directory', definition('Cannot be enumerated'));
    await writeAgent('user', 'available-user', definition('Still available'));
    vi.spyOn(secureFs, 'readdir').mockRejectedValueOnce(new Error('directory unavailable'));
    expect((await discoverFilesystemAgents(project)).map((agent) => agent.name)).toEqual([
      'available-user',
    ]);
  });
});

import type { Request, Response } from 'express';
import type { SettingsService } from '../../../services/settings-service.js';
import { spawnProcess } from '@automaker/platform';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs/promises';

class ImportError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export function githubRepository(input: unknown): { repository: string; url: string } {
  if (typeof input !== 'string') throw new ImportError(400, 'Invalid GitHub repository URL');
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new ImportError(400, 'Invalid GitHub repository URL');
  }
  // Validate the original path too: URL normalizes dot segments before exposing pathname.
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
    input
  );
  if (
    !match ||
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'github.com' ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash ||
    ['.', '..'].includes(match[2])
  )
    throw new ImportError(400, 'Invalid GitHub repository URL');
  const repository = `${match[1]}/${match[2]}`;
  return { repository, url: `https://github.com/${repository}.git` };
}

function contained(root: string, target: string) {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

type MetadataReader = (endpoint: string) => Promise<any>;
export async function githubMetadata(endpoint: string) {
  const response = await fetch(`https://api.github.com/${endpoint}`, {
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(process.env.GITHUB_PAT ? { Authorization: `Bearer ${process.env.GITHUB_PAT}` } : {}),
    },
  });
  if (!response.ok)
    throw new ImportError(403, 'Cannot verify repository write authorization and branch rules');
  return response.json();
}

// Serialize registration and destination reservation across handler instances in this server.
let importing = false;
export function createImportGithubHandler(
  settingsService: SettingsService,
  metadata: MetadataReader = githubMetadata
) {
  return async (req: Request, res: Response): Promise<void> => {
    if (importing) {
      res.status(409).json({ success: false, error: 'Another import is in progress' });
      return;
    }
    importing = true;
    let reserved: string | undefined;
    let registered = false;
    try {
      const { repoUrl, projectName, parentDir } = req.body || {};
      const { repository, url } = githubRepository(repoUrl);
      if (
        typeof projectName !== 'string' ||
        !/^[a-zA-Z0-9_-]+$/.test(projectName) ||
        typeof parentDir !== 'string' ||
        !path.isAbsolute(parentDir)
      )
        throw new ImportError(400, 'Invalid projectName or parentDir');
      const root = await fs.realpath(process.env.ALLOWED_ROOT_DIRECTORY || '/app/data/projects');
      const parent = await fs.realpath(parentDir);
      if (!contained(root, parent))
        throw new ImportError(403, 'Invalid parentDir or traversal attempted');
      const projectPath = path.join(parent, projectName);
      const git = (args: string[], cwd = parent) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 120000);
        const env: Record<string, string> = Object.fromEntries(
          [
            'PATH',
            'SystemRoot',
            'WINDIR',
            'HTTPS_PROXY',
            'HTTP_PROXY',
            'ALL_PROXY',
            'NO_PROXY',
            'https_proxy',
            'http_proxy',
            'all_proxy',
            'no_proxy',
            'SSL_CERT_FILE',
            'GIT_SSL_CAINFO',
          ].flatMap((name) => (process.env[name] ? [[name, process.env[name]!]] : []))
        );
        Object.assign(env, {
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
        });
        if (process.env.GITHUB_PAT) {
          env.GIT_CONFIG_COUNT = '1';
          env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
          env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${process.env.GITHUB_PAT}`).toString('base64')}`;
        }
        return spawnProcess({
          command: 'git',
          args: [
            '-c',
            'http.followRedirects=false',
            '-c',
            'core.hooksPath=/dev/null',
            '-c',
            'protocol.allow=never',
            '-c',
            'protocol.https.allow=always',
            ...args,
          ],
          cwd,
          env,
          inheritEnv: false,
          maxOutputBytes: 1048576,
          abortController: controller,
          sanitizeOutput: () => 'GitHub import subprocess',
        })
          .then((result) => {
            if (result.exitCode !== 0) throw new Error('Import Git verification failed');
            return result.stdout;
          })
          .finally(() => clearTimeout(timer));
      };
      const settings = await settingsService.getGlobalSettings();
      for (const project of settings.projects || []) {
        if (
          path.resolve(project.path) === projectPath ||
          (await fs.realpath(project.path).catch(() => '')) === projectPath
        )
          throw new ImportError(409, 'Project already registered');
        let origin: string;
        try {
          origin = (await git(['remote', 'get-url', 'origin'], project.path)).trim();
        } catch {
          continue;
        }
        try {
          if (
            githubRepository(
              origin.replace(
                /^git@github\.com:([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)$/,
                'https://github.com/$1'
              )
            ).repository.toLowerCase() === repository.toLowerCase()
          )
            throw new ImportError(409, 'Repository already imported');
        } catch (error) {
          if (error instanceof ImportError && error.status === 409) throw error;
        }
      }
      const repo = await metadata(`repos/${repository}`);
      if (
        repo.full_name?.toLowerCase() !== repository.toLowerCase() ||
        repo.clone_url?.toLowerCase() !== url.toLowerCase() ||
        !Number.isSafeInteger(repo.id) ||
        repo.permissions?.push !== true ||
        repo.archived ||
        repo.disabled ||
        typeof repo.default_branch !== 'string' ||
        !repo.default_branch
      )
        throw new ImportError(403, 'Repository identity or write authorization not verified');
      const branch = repo.default_branch;
      const branchInfo = await metadata(
        `repos/${repository}/branches/${encodeURIComponent(branch)}`
      );
      if (branchInfo.name !== branch || !/^(?!0{40}$)[a-f0-9]{40}$/i.test(branchInfo.commit?.sha))
        throw new ImportError(403, 'Default branch identity not verified');
      // Effective rules include repository/organization rulesets, even when legacy protection is absent.
      const rules = await metadata(
        `repos/${repository}/rules/branches/${encodeURIComponent(branch)}`
      );
      if (!Array.isArray(rules)) throw new ImportError(403, 'Branch rules not verified');
      const protection = branchInfo.protected
        ? await metadata(`repos/${repository}/branches/${encodeURIComponent(branch)}/protection`)
        : null;
      if (branchInfo.protected && (!protection || typeof protection !== 'object'))
        throw new ImportError(403, 'Protected branch rules not verified');
      if (protection?.lock_branch?.enabled || rules.some((rule: any) => rule.type === 'update'))
        throw new ImportError(403, 'Default branch is locked or updates are restricted');
      const remote = await git(['ls-remote', '--symref', url, 'HEAD', `refs/heads/${branch}`]);
      const sha = branchInfo.commit.sha;
      if (
        !remote.split(/\r?\n/).includes(`ref: refs/heads/${branch}\tHEAD`) ||
        !remote.split(/\r?\n/).includes(`${sha}\tHEAD`) ||
        !remote.split(/\r?\n/).includes(`${sha}\trefs/heads/${branch}`)
      )
        throw new ImportError(
          409,
          'Remote default branch changed or identity mismatch; retry import'
        );
      // Atomic reservation rejects existing files, directories and dangling symlinks.
      try {
        await fs.mkdir(projectPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw new ImportError(409, 'Project directory already exists');
        throw error;
      }
      reserved = projectPath;
      if (
        (await fs.realpath(parentDir)) !== parent ||
        (await fs.realpath(projectPath)) !== projectPath ||
        !contained(await fs.realpath(root), await fs.realpath(projectPath))
      )
        throw new ImportError(403, 'Import directory changed');
      await git(['clone', '--no-recurse-submodules', '--branch', branch, '--', url, projectPath]);
      const [head, origin, clonedBranch] = await Promise.all([
        git(['rev-parse', 'HEAD'], projectPath),
        git(['remote', 'get-url', 'origin'], projectPath),
        git(['symbolic-ref', '--short', 'HEAD'], projectPath),
      ]);
      if (
        head.trim() !== sha ||
        origin.trim() !== url ||
        clonedBranch.trim() !== branch ||
        (await fs.realpath(projectPath)) !== projectPath ||
        (await fs.realpath(parentDir)) !== parent
      )
        throw new ImportError(409, 'Cloned repository identity changed; retry import');
      const projectId = randomUUID();
      // Re-read to preserve unrelated settings updates made during the clone.
      const latest = await settingsService.getGlobalSettings();
      if (latest.projects?.some((p) => path.resolve(p.path) === projectPath))
        throw new ImportError(409, 'Project already registered');
      await settingsService.updateGlobalSettings({
        projects: [
          ...(latest.projects || []),
          { id: projectId, name: projectName, path: projectPath },
        ],
      });
      registered = true;
      res.status(200).json({
        success: true,
        projectId,
        projectPath,
        projectName,
        repositoryId: repo.id,
        repository: repo.full_name,
        defaultBranch: branch,
        baseSha: sha,
        writePolicy: {
          repositoryWrite: true,
          defaultBranchProtected: Boolean(branchInfo.protected || rules.length),
          requiresPullRequest: true,
        },
        message: 'Repository history and origin preserved; changes require reviewed pull requests',
      });
    } catch (error) {
      res.status(error instanceof ImportError ? error.status : 503).json({
        success: false,
        error:
          error instanceof ImportError
            ? error.message
            : 'Repository import or authorization verification failed',
      });
    } finally {
      if (reserved && !registered) {
        // Never follow a replaced destination when cleaning up a failed import.
        try {
          if ((await fs.realpath(reserved)) === reserved)
            await fs.rm(reserved, { recursive: true, force: true });
        } catch {
          /* retained for operator inspection */
        }
      }
      importing = false;
    }
  };
}

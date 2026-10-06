import fs from 'fs/promises';
import path from 'path';
import { execGitCommand } from '@automaker/git-utils';
import type { SeniorWorktreeAdapter } from './milestone-d-orchestrator.js';

export class GitSeniorWorktreeAdapter implements SeniorWorktreeAdapter {
  async prepare(projectPath: string, branch: string, baseSha: string): Promise<string> {
    const directory = path.join(
      path.dirname(projectPath),
      '.automaker-worktrees',
      path.basename(projectPath),
      branch.replace(/[^a-z0-9._-]+/gi, '-')
    );
    try {
      await fs.access(path.join(directory, '.git'));
      return directory;
    } catch {
      await fs.mkdir(path.dirname(directory), { recursive: true });
      await execGitCommand(['worktree', 'add', '-b', branch, directory, baseSha], projectPath);
      return directory;
    }
  }

  async commit(worktree: string, message: string): Promise<string> {
    const charterChanges = (
      await execGitCommand(['status', '--porcelain', '--', 'ARGUS.md'], worktree)
    ).trim();
    if (charterChanges) throw new Error('SENIOR_ARGUS_CHARTER_MUTATION_FORBIDDEN');
    await execGitCommand(['add', '-A'], worktree);
    const staged = (await execGitCommand(['diff', '--cached', '--name-only'], worktree)).trim();
    if (!staged) throw new Error('SENIOR_PATCH_EMPTY');
    await execGitCommand(['commit', '-m', message], worktree);
    return (await execGitCommand(['rev-parse', 'HEAD'], worktree)).trim();
  }
}

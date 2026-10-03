import { execGitCommand } from '@automaker/git-utils';
import { spawnProcess } from '@automaker/platform';
import { normalizeGitHubRepository } from './jules-client.js';

export interface GitDispatchContext {
  repository: string;
  baseBranch: string;
  baseRemoteSha: string;
}
export async function captureGitDispatchContext(projectPath: string): Promise<GitDispatchContext> {
  const remoteUrl = (await execGitCommand(['remote', 'get-url', 'origin'], projectPath)).trim();
  const repository = normalizeGitHubRepository(remoteUrl);
  if (!repository) throw new Error('JULES_SOURCE_NOT_FOUND: origin is not a GitHub repository');
  await execGitCommand(['fetch', '--prune', 'origin'], projectPath);
  let baseBranch = '';
  try {
    baseBranch = (
      await execGitCommand(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], projectPath)
    )
      .trim()
      .replace(/^origin\//, '');
  } catch {
    baseBranch = (await execGitCommand(['branch', '--show-current'], projectPath)).trim();
  }
  if (!baseBranch)
    throw new Error('GITHUB_PR_LOOKUP_FAILED: could not determine integration branch');
  const baseRemoteSha = (
    await execGitCommand(['rev-parse', `origin/${baseBranch}`], projectPath)
  ).trim();
  return { repository, baseBranch, baseRemoteSha };
}
export async function verifyPullRequest(
  url: string,
  projectPath: string
): Promise<{ number: number; url: string; headSha: string; branch: string }> {
  const result = await spawnProcess({
    command: 'gh',
    args: ['pr', 'view', url, '--json', 'number,url,headRefName,headRefOid'],
    cwd: projectPath,
    env: process.env as Record<string, string>,
  });
  if (result.exitCode !== 0) throw new Error('GITHUB_PR_LOOKUP_FAILED');
  const value = JSON.parse(result.stdout) as {
    number: number;
    url: string;
    headRefName: string;
    headRefOid: string;
  };
  return {
    number: value.number,
    url: value.url,
    headSha: value.headRefOid,
    branch: value.headRefName,
  };
}

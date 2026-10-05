import { execGitCommand } from '@automaker/git-utils';
import { spawnProcess } from '@automaker/platform';
import { normalizeGitHubRepository } from './jules-client.js';

export interface GitDispatchContext {
  repository: string;
  baseBranch: string;
  baseRemoteSha: string;
}
function ghEnv(): Record<string, string> {
  return Object.fromEntries(
    [
      ['PATH', process.env.PATH],
      ['HOME', process.env.HOME],
      ['GH_TOKEN', process.env.GITHUB_PAT],
    ].filter((entry): entry is [string, string] => Boolean(entry[1]))
  );
}
export async function captureGitDispatchContext(
  projectPath: string,
  explicitBaseBranch?: string
): Promise<GitDispatchContext> {
  const remoteUrl = (await execGitCommand(['remote', 'get-url', 'origin'], projectPath)).trim();
  const repository = normalizeGitHubRepository(remoteUrl);
  if (!repository) throw new Error('JULES_SOURCE_NOT_FOUND: origin is not a GitHub repository');
  await execGitCommand(['fetch', '--prune', 'origin'], projectPath);
  let baseBranch = explicitBaseBranch || '';
  if (!baseBranch)
    try {
      const result = await spawnProcess({
        command: 'gh',
        args: [
          'repo',
          'view',
          repository,
          '--json',
          'defaultBranchRef',
          '--jq',
          '.defaultBranchRef.name',
        ],
        cwd: projectPath,
        env: ghEnv(),
      });
      if (result.exitCode === 0) baseBranch = result.stdout.trim();
    } catch {
      /* fall through to origin/HEAD */
    }
  if (!baseBranch)
    try {
      baseBranch = (
        await execGitCommand(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], projectPath)
      )
        .trim()
        .replace(/^origin\//, '');
    } catch {
      /* fail closed below */
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
  projectPath: string,
  expected: { repository: string; baseBranch: string; branch?: string }
): Promise<{ number: number; url: string; headSha: string; branch: string }> {
  const result = await spawnProcess({
    command: 'gh',
    args: [
      'pr',
      'view',
      url,
      '--json',
      'number,url,state,baseRefName,headRefName,headRefOid,headRepositoryOwner,headRepository',
    ],
    cwd: projectPath,
    env: ghEnv(),
  });
  if (result.exitCode !== 0) throw new Error('GITHUB_PR_LOOKUP_FAILED');
  const value = JSON.parse(result.stdout) as {
    number: number;
    url: string;
    headRefName: string;
    headRefOid: string;
    state: string;
    baseRefName: string;
    headRepositoryOwner: { login: string };
    headRepository: { name: string };
  };
  const repository =
    `${value.headRepositoryOwner.login}/${value.headRepository.name}`.toLowerCase();
  if (
    value.state !== 'OPEN' ||
    value.baseRefName !== expected.baseBranch ||
    repository !== expected.repository.toLowerCase() ||
    (expected.branch && value.headRefName !== expected.branch)
  )
    throw new Error('GITHUB_PR_LOOKUP_FAILED: PR identity mismatch');
  return {
    number: value.number,
    url: value.url,
    headSha: value.headRefOid,
    branch: value.headRefName,
  };
}

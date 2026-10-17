import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execGitCommand } from '@automaker/git-utils';
import { bootstrapStarterProject } from '../../../src/services/bootstrap-starter-project.js';
import {
  ensureArgusControlFiles,
  resolveState,
  saveArgusState,
} from '../../../src/services/argus/project-lifecycle.js';
import { updateDurableJson, readDurableJson } from '../../../src/services/argus/durable-store.js';
import { readBuildIdentity } from '../../../src/lib/build-identity.js';

let dir: string;
let fixtureRemoteDir: string;
let fixtureRemoteUrl: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-foundation-'));

  // Create a real bare git repository to act as a test remote
  fixtureRemoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-fixture-remote-'));
  await execGitCommand(['init', '--bare'], fixtureRemoteDir);
  fixtureRemoteUrl = `file://${fixtureRemoteDir}`;

  // Populate the bare repository by pushing to it from a temporary workspace
  const tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-fixture-workspace-'));
  await execGitCommand(['init'], tempWorkspace);
  await execGitCommand(['config', 'user.name', 'Fixture Author'], tempWorkspace);
  await execGitCommand(['config', 'user.email', 'fixture@example.test'], tempWorkspace);
  await fs.writeFile(path.join(tempWorkspace, 'fixture.txt'), 'fixture content');
  await execGitCommand(['add', 'fixture.txt'], tempWorkspace);
  await execGitCommand(['commit', '-m', 'fixture commit'], tempWorkspace);
  await execGitCommand(['remote', 'add', 'origin', fixtureRemoteUrl], tempWorkspace);
  await execGitCommand(['push', 'origin', 'master:main'], tempWorkspace);

  // Setup bare repository config to allow pushing to a branch without erroring on "current branch" checks
  // Even for a bare repo sometimes this helps, though for push to refs/heads/automaker-bootstrap-test it shouldn't matter
  await execGitCommand(['config', 'receive.denyNonFastForwards', 'false'], fixtureRemoteDir);

  // Tests simulate dry run push to automaker-bootstrap-test, we need a ref to be created or allow dry run pushes.
  // For file URLs a dry run push is allowed if we have a tracking remote.
  await execGitCommand(['config', 'receive.denyCurrentBranch', 'ignore'], fixtureRemoteDir);
  await fs.rm(tempWorkspace, { recursive: true, force: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(fixtureRemoteDir, { recursive: true, force: true }).catch(() => {});
});

const options = () => ({
  projectPath: dir,
  projectId: 'starter',
  projectName: 'starter',
  destinationRepoUrl: fixtureRemoteUrl,
});

const state = async () =>
  JSON.parse(await fs.readFile(path.join(dir, '.automaker/bootstrap-state.json'), 'utf8'));

const head = () => execGitCommand(['rev-parse', '--verify', 'HEAD'], dir);

async function git() {
  await execGitCommand(['init'], dir);
  await execGitCommand(['config', 'user.name', 'Test'], dir);
  await execGitCommand(['config', 'user.email', 'test@example.test'], dir);
  await fs.writeFile(path.join(dir, 'README.md'), '# Fixture');
}

describe('bootstrap baseline invariant', () => {
  it('commits an initial baseline and repeated calls do not duplicate work', async () => {
    await git();
    await bootstrapStarterProject(options());
    expect((await execGitCommand(['ls-files', '--', '.automaker'], dir)).trim()).toBe('');
    const first = await head();
    expect((await state()).completedPhases).toContain('baseline-commit');
    expect((await state()).completedPhases).toContain('configure-remote');

    // Repeated call
    await bootstrapStarterProject(options());
    expect(await head()).toBe(first);
  });

  it('fails gracefully when remote repository cannot be resolved', async () => {
    await git();
    const badOptions = options();
    badOptions.destinationRepoUrl = 'file:///non/existent/remote/path.git';

    await bootstrapStarterProject(badOptions);

    const s = await state();
    expect(s.completedPhases).toContain('baseline-commit'); // We made it this far
    expect(s.completedPhases).not.toContain('configure-remote'); // But failed here
    expect(s.lastError).toBe('BOOTSTRAP_REMOTE_VERIFICATION_FAILED');
  });

  it('retains a truthful partial state on failure and recovers after restart', async () => {
    await git();
    const hookDir = path.join(dir, '.git/hooks');
    await fs.mkdir(hookDir, { recursive: true });
    const hook = path.join(hookDir, 'pre-commit');
    await fs.writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    const register = vi.fn();

    await bootstrapStarterProject({
      ...options(),
      destinationRepoUrl: undefined,
      settingsService: { getGlobalSettings: register } as any,
    });

    expect((await state()).completedPhases).not.toContain('baseline-commit');
    expect((await state()).lastError).toBe('BOOTSTRAP_BASELINE_HEAD_MISSING');
    expect(register).not.toHaveBeenCalled();
    await expect(head()).rejects.toThrow();

    // Repair and recover
    await fs.unlink(hook);
    await bootstrapStarterProject({ ...options(), destinationRepoUrl: undefined });

    expect((await state()).completedPhases).toContain('baseline-commit');
    expect(await head()).toMatch(/[a-f0-9]{40}/);
  });

  it('accepts an existing valid HEAD without creating another commit', async () => {
    await git();
    await execGitCommand(['add', '.'], dir);
    await execGitCommand(['commit', '-m', 'existing'], dir);
    const first = await head();
    await bootstrapStarterProject(options());
    expect(await head()).toBe(first);
    expect((await state()).completedPhases).toContain('baseline-commit');
    expect((await state()).completedPhases).toContain('configure-remote');
  });

  it('repairs an incorrectly marked phase on an unborn repository', async () => {
    await git();
    await fs.mkdir(path.join(dir, '.automaker'));
    await fs.writeFile(
      path.join(dir, '.automaker/bootstrap-state.json'),
      JSON.stringify({
        completedPhases: ['baseline-commit'],
        bootstrappedAt: new Date().toISOString(),
      })
    );
    const hookDir = path.join(dir, '.git/hooks');
    await fs.mkdir(hookDir, { recursive: true });
    await fs.writeFile(path.join(hookDir, 'pre-commit'), '#!/bin/sh\nexit 1\n', {
      mode: 0o700,
    });
    await bootstrapStarterProject({ ...options(), destinationRepoUrl: undefined });
    expect((await state()).completedPhases).not.toContain('baseline-commit');
  });

  it('serializes simultaneous bootstrap calls', async () => {
    await git();
    await Promise.all([bootstrapStarterProject(options()), bootstrapStarterProject(options())]);
    expect((await execGitCommand(['rev-list', '--count', 'HEAD'], dir)).trim()).toBe('1');
  });
});

describe('durable authoritative state', () => {
  it('rejects a stale writer while retaining revisions and task fields', async () => {
    await ensureArgusControlFiles(dir, '# spec', '# objective');
    const original = await resolveState('p', dir, 'opencode/model');
    const stale = structuredClone(original);
    original.reconciliation.attempt = 2;
    await saveArgusState(dir, original);
    await expect(saveArgusState(dir, stale)).rejects.toThrow('ARGUS_STATE_REVISION_CONFLICT');
    const saved = await readDurableJson<any>(path.join(dir, '.automaker/argus-state.json'));
    expect(saved.reconciliation.attempt).toBe(2);
    expect(saved.stateRevision).toBe(original.stateRevision);
  });

  it('retains the previous complete JSON when rename fails', async () => {
    const file = path.join(dir, 'state.json');
    await updateDurableJson(file, () => ({ revision: 1 }));
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('injected crash'));
    await expect(updateDurableJson(file, () => ({ revision: 2 }))).rejects.toThrow(
      'injected crash'
    );
    expect(await readDurableJson(file)).toEqual({ revision: 1 });
    expect((await fs.readdir(dir)).filter((n) => n.includes('.tmp.'))).toEqual([]);
  });

  it('serializes increments and refuses to replace corrupt state', async () => {
    const file = path.join(dir, 'counter.json');
    await Promise.all(
      Array.from({ length: 12 }, () =>
        updateDurableJson<{ count: number }>(file, (c) => ({ count: (c?.count || 0) + 1 }))
      )
    );
    expect(await readDurableJson(file)).toEqual({ count: 12 });
    await fs.writeFile(file, 'truncated{');
    await expect(updateDurableJson(file, () => ({ count: 0 }))).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe('truncated{');
  });
});

it('reports build provenance and installed capabilities without claiming unavailable tools work', async () => {
  vi.stubEnv('BUILD_GIT_SHA', 'a'.repeat(40));
  vi.stubEnv('BUILD_TIMESTAMP', '2026-10-15T00:00:00Z');
  const identity = await readBuildIdentity(async (command) => {
    if (command === 'opencode') return '1.18.35';
    throw new Error('unavailable');
  });
  expect(identity.gitSha).toBe('a'.repeat(40));
  expect(identity.opencode).toEqual({ installed: true, version: '1.18.35' });
  expect(identity.argus.installed).toBe(false);
  expect(identity.lokiAdapterAvailable).toBe(false);
});

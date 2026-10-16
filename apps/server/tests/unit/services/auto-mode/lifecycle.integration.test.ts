import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import express from 'express';
import request from 'supertest';
import type { Feature } from '@automaker/types';
import { getExecutionStatePath, getFeatureDir } from '@automaker/platform';
import { createEventEmitter } from '@/lib/events.js';
import { AutoModeServiceCompat } from '@/services/auto-mode/compat.js';
import { FeatureLoader } from '@/services/feature-loader.js';
import { AgentExecutor } from '@/services/agent-executor.js';
import { createAutoModeRoutes } from '@/routes/auto-mode/index.js';

describe('AutoMode lifecycle across the compatibility boundary', () => {
  let root: string;
  let alpha: string;
  let beta: string;
  let features: FeatureLoader;
  let service: AutoModeServiceCompat;
  let emitted: Array<Record<string, unknown>>;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      encoding: 'utf8',
    }).trim();

  async function create(projectPath: string, id: string, extra: Partial<Feature> = {}) {
    return features.create(projectPath, {
      id,
      title: id,
      description: `Implement ${id}`,
      status: 'backlog',
      ...extra,
    });
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'automaker-facade-lifecycle-'));
    alpha = path.join(root, 'alpha');
    beta = path.join(root, 'beta');
    for (const directory of [alpha, beta]) {
      await fs.mkdir(directory);
      git(directory, 'init', '--quiet', '--initial-branch=main');
      git(directory, 'config', 'user.name', 'Lifecycle fixture');
      git(directory, 'config', 'user.email', 'lifecycle@example.invalid');
      await fs.writeFile(path.join(directory, 'README.md'), '# Fixture\n');
      await fs.writeFile(path.join(directory, '.gitignore'), '.automaker/\n');
      git(directory, 'add', '.');
      git(directory, 'commit', '--quiet', '-m', 'Baseline fixture');
    }
    features = new FeatureLoader();
    const events = createEventEmitter();
    emitted = [];
    events.subscribe((type, payload) => {
      if (type === 'auto-mode:event') emitted.push(payload as Record<string, unknown>);
    });
    service = new AutoModeServiceCompat(events, null, features);
  });

  afterEach(async () => {
    for (const directory of [alpha, beta]) {
      await service.stopAutoLoopForProject(directory);
      await service.stopAutoLoopForProject(directory, 'topic');
    }
    // Notifications persist asynchronously after events. Allow those bounded writes to finish.
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
    vi.restoreAllMocks();
  });

  it.each([
    { category: 'Argus' },
    { orchestrator: 'argus' },
    { executionOwner: 'argus-autonomy' },
    { argus: { taskId: 'canonical-task' } },
  ])('refuses generic execution for every persisted ownership marker: %j', async (ownership) => {
    await create(alpha, 'owned', ownership as Partial<Feature>);
    const executor = vi.spyOn(AgentExecutor.prototype, 'execute');
    const before = await fs.readFile(
      path.join(getFeatureDir(alpha, 'owned'), 'feature.json'),
      'utf8'
    );
    await expect(service.executeFeature(alpha, 'owned')).rejects.toThrow(
      'ARGUS_TASK_REQUIRES_RUNNER'
    );
    expect(executor).not.toHaveBeenCalled();
    expect(service.getStatus().runningCount).toBe(0);
    expect(
      await fs.readFile(path.join(getFeatureDir(alpha, 'owned'), 'feature.json'), 'utf8')
    ).toBe(before);
  });

  it('filters Argus ownership and branch alignment inside the running auto-loop', async () => {
    await create(alpha, 'owned', { argus: { taskId: 'canonical' } } as Partial<Feature>);
    await create(alpha, 'other-branch', { branchName: 'topic' });
    const executor = vi.spyOn(AgentExecutor.prototype, 'execute');
    await service.startAutoLoopForProject(alpha, null, 1);
    await vi.waitFor(() => {
      expect(emitted.some((event) => event.type === 'auto_mode_idle')).toBe(true);
    });
    expect(executor).not.toHaveBeenCalled();
    expect(emitted.filter((event) => event.type === 'auto_mode_error')).toEqual([]);
    expect((await features.get(alpha, 'owned'))?.status).toBe('backlog');
  });

  it('keeps project facades stable and reports the actual active project/worktree registry', async () => {
    const facade = service.createFacade(alpha);
    expect(service.createFacade(alpha)).toBe(facade);
    expect(service.createFacade(beta)).not.toBe(facade);
    await service.startAutoLoopForProject(alpha, null, 2);
    await service.startAutoLoopForProject(beta, 'topic', 1);
    expect(service.getActiveAutoLoopProjects().sort()).toEqual([alpha, beta].sort());
    expect(service.getActiveAutoLoopWorktrees()).toEqual(
      expect.arrayContaining([
        { projectPath: alpha, branchName: null },
        { projectPath: beta, branchName: 'topic' },
      ])
    );
    await expect(service.startAutoLoopForProject(alpha)).rejects.toThrow('already running');
    await service.stopAutoLoopForProject(alpha);
    expect(service.isAutoLoopRunningForProject(alpha)).toBe(false);
    expect(service.isAutoLoopRunningForProject(beta, 'topic')).toBe(true);
    expect(service.getActiveAutoLoopProjects()).toEqual([beta]);
    expect(facade.getAutoLoopConfig()).toBeNull();
    expect(facade.getActiveAutoLoopProjects()).toEqual([]);
    expect(facade.getActiveAutoLoopWorktrees()).toEqual([]);
  });

  it('normalizes the primary branch and counts manual agents against per-worktree capacity', async () => {
    await create(alpha, 'candidate', { branchName: 'main', status: 'verified' });
    await create(alpha, 'manual', { branchName: 'main', status: 'in_progress' });
    await create(beta, 'elsewhere', { status: 'in_progress' });
    const concurrency = service.getGlobalService().getSharedServices().concurrencyManager;
    const local = concurrency.acquire({
      featureId: 'manual',
      projectPath: alpha,
      isAutoMode: false,
    });
    local.branchName = 'main';
    concurrency.acquire({ featureId: 'elsewhere', projectPath: beta, isAutoMode: true });
    await service.startAutoLoopForProject(alpha, null, 1);
    expect(await service.checkWorktreeCapacity(alpha, 'candidate')).toEqual({
      hasCapacity: false,
      currentAgents: 1,
      maxAgents: 1,
      branchName: null,
    });
    expect(await service.getStatusForProject(alpha)).toMatchObject({
      runningFeatures: ['manual'],
      runningCount: 1,
      maxConcurrency: 1,
    });
    expect(service.createFacade(alpha).getStatus().runningCount).toBe(2);
    concurrency.release('manual');
    expect((await service.checkWorktreeCapacity(alpha, 'candidate')).hasCapacity).toBe(true);
  });

  it('persists scoped recovery state and clears it when the loop stops', async () => {
    const concurrency = service.getGlobalService().getSharedServices().concurrencyManager;
    concurrency.acquire({ featureId: 'local', projectPath: alpha, isAutoMode: true });
    concurrency.acquire({ featureId: 'elsewhere', projectPath: beta, isAutoMode: true });
    await service.startAutoLoopForProject(alpha, 'topic', 4);
    const state = JSON.parse(await fs.readFile(getExecutionStatePath(alpha), 'utf8'));
    expect(state).toMatchObject({
      projectPath: alpha,
      branchName: 'topic',
      maxConcurrency: 4,
      runningFeatureIds: ['local'],
    });
    await service.stopAutoLoopForProject(alpha, 'topic');
    await expect(fs.access(getExecutionStatePath(alpha))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(service.getStatus().runningCount).toBe(2);
  });

  it('projects global agent metadata and persists interruption across projects on shutdown', async () => {
    await create(alpha, 'first', { status: 'in_progress', branchName: 'main' });
    await create(beta, 'second', { status: 'pipeline_testing', branchName: 'topic' });
    const concurrency = service.getGlobalService().getSharedServices().concurrencyManager;
    concurrency.acquire({ featureId: 'first', projectPath: alpha, isAutoMode: false });
    concurrency.acquire({ featureId: 'second', projectPath: beta, isAutoMode: true });
    const agents = await service.getRunningAgents();
    expect(agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          featureId: 'first',
          projectName: 'alpha',
          title: 'first',
          isAutoMode: false,
        }),
        expect.objectContaining({
          featureId: 'second',
          projectName: 'beta',
          branchName: 'topic',
          isAutoMode: true,
        }),
      ])
    );
    expect(await service.createFacade(alpha).getRunningAgents()).toEqual(agents);
    await service.markAllRunningFeaturesInterrupted('server stopping');
    expect((await features.get(alpha, 'first'))?.status).toBe('interrupted');
    expect((await features.get(beta, 'second'))?.status).toBe('pipeline_testing');
    await service.createFacade(alpha).markAllRunningFeaturesInterrupted();
    expect((await features.get(alpha, 'first'))?.status).toBe('interrupted');
  });

  it('reconciles generic crash state without rewriting the Argus projection', async () => {
    await create(alpha, 'interrupted', { status: 'in_progress' });
    await create(alpha, 'approved', {
      status: 'interrupted',
      planSpec: { status: 'approved', version: 1, reviewedByUser: true },
    });
    await create(alpha, 'owned', { status: 'in_progress', executionOwner: 'argus-autonomy' });
    expect(await service.reconcileFeatureStates(alpha)).toBe(2);
    expect((await features.get(alpha, 'interrupted'))?.status).toBe('backlog');
    expect((await features.get(alpha, 'approved'))?.status).toBe('ready');
    expect((await features.get(alpha, 'owned'))?.status).toBe('in_progress');
    expect(emitted.find((event) => event.type === 'features_reconciled')).toMatchObject({
      reconciledCount: 2,
    });
  });

  it('cannot resume an Argus pipeline through generic recovery or bulk restart', async () => {
    await create(alpha, 'owned', { status: 'pipeline_testing', executionOwner: 'argus-autonomy' });
    const before = await fs.readFile(
      path.join(getFeatureDir(alpha, 'owned'), 'feature.json'),
      'utf8'
    );
    const executor = vi.spyOn(AgentExecutor.prototype, 'execute');
    await expect(service.resumeFeature(alpha, 'owned')).rejects.toThrow(
      'ARGUS_TASK_REQUIRES_RUNNER'
    );
    await service.resumeInterruptedFeatures(alpha);
    expect(executor).not.toHaveBeenCalled();
    expect(service.getStatus().runningCount).toBe(0);
    expect(
      await fs.readFile(path.join(getFeatureDir(alpha, 'owned'), 'feature.json'), 'utf8')
    ).toBe(before);
    expect(emitted.some((event) => event.type === 'auto_mode_resuming_features')).toBe(false);
  });

  it('blocks generic verification, commits, follow-up and approvals before Argus mutation', async () => {
    await create(alpha, 'owned', {
      executionOwner: 'argus-autonomy',
      planSpec: { status: 'generated', version: 1, reviewedByUser: false },
    });
    const before = git(alpha, 'rev-parse', 'HEAD');
    await fs.writeFile(
      path.join(alpha, 'package.json'),
      JSON.stringify({
        scripts: {
          lint: 'node -e "process.exit(0)"',
          typecheck: 'node -e "process.exit(0)"',
          test: 'node -e "process.exit(0)"',
          build: 'node -e "process.exit(0)"',
        },
      })
    );
    await expect(service.verifyFeature(alpha, 'owned')).rejects.toThrow(
      'ARGUS_TASK_REQUIRES_RUNNER'
    );
    await expect(service.commitFeature(alpha, 'owned')).rejects.toThrow(
      'ARGUS_TASK_REQUIRES_RUNNER'
    );
    await expect(service.followUpFeature(alpha, 'owned', 'implement')).rejects.toThrow(
      'ARGUS_TASK_REQUIRES_RUNNER'
    );
    await expect(service.resolvePlanApproval(alpha, 'owned', true)).rejects.toThrow(
      'ARGUS_TASK_REQUIRES_RUNNER'
    );
    expect(git(alpha, 'rev-parse', 'HEAD')).toBe(before);
    expect((await features.get(alpha, 'owned'))?.planSpec?.status).toBe('generated');
  });

  it('serves real project-specific context and global loop state through existing HTTP handlers', async () => {
    await create(alpha, 'context');
    await create(beta, 'context');
    await features.saveAgentOutput(alpha, 'context', 'saved previous implementation');
    await service.startAutoLoopForProject(beta, 'topic', 1);
    const app = express().use(express.json()).use('/auto-mode', createAutoModeRoutes(service));
    expect(
      (
        await request(app)
          .post('/auto-mode/context-exists')
          .send({ projectPath: alpha, featureId: 'context' })
      ).body
    ).toEqual({ success: true, exists: true });
    expect(
      (
        await request(app)
          .post('/auto-mode/context-exists')
          .send({ projectPath: beta, featureId: 'context' })
      ).body
    ).toEqual({ success: true, exists: false });
    const status = await request(app).post('/auto-mode/status').send({});
    expect(status.body.activeAutoLoopProjects).toEqual([beta]);
    expect(status.body.activeAutoLoopWorktrees).toEqual([
      { projectPath: beta, branchName: 'topic' },
    ]);
  });

  it('detects only missing branches from actual repository refs and tolerates missing repositories', async () => {
    git(alpha, 'branch', 'present');
    await create(alpha, 'primary', { branchName: 'main' });
    await create(alpha, 'present', { branchName: 'present' });
    await create(alpha, 'orphan', { branchName: 'missing' });
    const facade = service.createFacade(alpha);
    expect((await facade.detectOrphanedFeatures()).map((item) => item.missingBranch)).toEqual([
      'missing',
    ]);
    expect(await facade.detectOrphanedFeatures([])).toEqual([]);
    const preloaded = await features.getAll(alpha);
    await fs.rm(path.join(alpha, '.git'), { recursive: true });
    expect(await service.detectOrphanedFeatures(alpha, preloaded)).toEqual([]);
    await expect(facade.analyzeProject()).rejects.toThrow('not fully implemented');
  });

  it('uses project-scoped pending approvals and cleans up cancellation without stale promises', async () => {
    await create(alpha, 'approval');
    await create(beta, 'approval');
    const first = service.createFacade(alpha);
    const second = service.createFacade(beta);
    const approved = first.waitForPlanApproval('approval');
    const cancelled = second.waitForPlanApproval('approval');
    const cancelledResult = cancelled.catch((error: Error) => error.message);
    await vi.waitFor(() =>
      expect(first.hasPendingApproval('approval') && second.hasPendingApproval('approval')).toBe(
        true
      )
    );
    expect(
      await service.resolvePlanApproval(alpha, 'approval', true, 'edited', 'reviewed')
    ).toEqual({ success: true, error: undefined });
    expect(await approved).toEqual({ approved: true, editedPlan: 'edited', feedback: 'reviewed' });
    expect(second.hasPendingApproval('approval')).toBe(true);
    second.cancelPlanApproval('approval');
    expect(await cancelledResult).toMatch(/cancel/i);
    expect(first.hasPendingApproval('approval')).toBe(false);
    expect(second.hasPendingApproval('approval')).toBe(false);
  });
});

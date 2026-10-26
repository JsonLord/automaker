import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import request from 'supertest';
import {
  inspectProjectDirectory,
  inspectProjectFeatures,
} from '../../../src/services/argus/project-inspection.js';
import { ArgusProjectAccess } from '../../../src/services/argus/project-access.js';
import { createOverviewHandler } from '../../../src/routes/projects/routes/overview.js';
let root: string;
const restore: string[] = [];
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-facts-'));
  vi.stubEnv('ALLOWED_ROOT_DIRECTORY', root);
});
afterEach(async () => {
  for (const p of restore.splice(0)) await fs.chmod(p, 0o700);
  await fs.rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
async function directory(name = 'project') {
  const p = path.join(root, name);
  await fs.mkdir(p, { recursive: true });
  return p;
}
describe('shared read-only physical filesystem inspection', () => {
  it('accepts registered nested paths without creating metadata', async () => {
    const p = await directory('nested/project');
    expect(await inspectProjectDirectory(p)).toEqual({ available: true, physicalPath: p });
    expect(await fs.readdir(p)).toEqual([]);
    const guard = new ArgusProjectAccess({
      getGlobalSettings: async () => ({ projects: [{ id: 'p', path: p }] }),
    } as never);
    expect(await guard.resolve({ projectId: 'p' })).toBe(p);
  });
  it.each(['missing', 'file', 'broken', 'escape', 'metadata', 'denied', 'parent'] as const)(
    'classifies %s identically for overview and guard',
    async (kind) => {
      let p = path.join(root, 'project');
      let reason = 'PROJECT_PATH_MISSING';
      if (kind === 'file') {
        await fs.writeFile(p, 'file');
        reason = 'PROJECT_NOT_DIRECTORY';
      }
      if (kind === 'broken') {
        await fs.symlink(path.join(root, 'missing'), p);
        reason = 'PROJECT_BROKEN_SYMLINK';
      }
      if (kind === 'escape') {
        await fs.symlink(os.tmpdir(), p);
        reason = 'PROJECT_OUTSIDE_ALLOWED_ROOT';
      }
      if (kind === 'metadata') {
        await directory();
        await fs.symlink(root, path.join(p, '.automaker'));
        reason = 'ARGUS_METADATA_SYMLINK_REFUSED';
      }
      if (kind === 'denied') {
        await directory();
        await fs.chmod(p, 0);
        restore.push(p);
        reason = 'PROJECT_DIRECTORY_DENIED';
      }
      if (kind === 'parent') {
        const parent = await directory('locked');
        p = path.join(parent, 'project');
        await fs.mkdir(p);
        await fs.chmod(parent, 0);
        restore.push(parent);
        reason = 'PROJECT_PARENT_INACCESSIBLE';
      }
      const result = await inspectProjectDirectory(p);
      expect(result).toMatchObject({ available: false, reason });
      const guard = new ArgusProjectAccess({
        getGlobalSettings: async () => ({ projects: [{ id: 'p', name: 'p', path: p }] }),
      } as never);
      await expect(guard.resolve({ projectId: 'p' })).rejects.toThrow(reason);
    }
  );
  it('retains registered identity and rejects cross-project or stale inputs', async () => {
    const a = await directory('a'),
      b = await directory('b');
    const guard = new ArgusProjectAccess({
      getGlobalSettings: async () => ({
        projects: [
          { id: 'a', path: a },
          { id: 'b', path: b },
        ],
      }),
    } as never);
    await expect(guard.resolve({ projectId: 'a', projectPath: b })).rejects.toThrow(
      'REGISTERED_PROJECT_NOT_FOUND'
    );
    await expect(guard.resolve({ projectId: 'stale' })).rejects.toThrow(
      'REGISTERED_PROJECT_NOT_FOUND'
    );
    await expect(guard.resolve({ projectPath: `${root}/../escape` })).rejects.toThrow(
      'INVALID_PROJECT_PATH'
    );
  });
  it('distinguishes missing, complete empty, corrupt and unreadable feature state without recovery writes', async () => {
    const p = await directory();
    expect(await inspectProjectFeatures(p)).toMatchObject({
      complete: false,
      reason: 'FEATURE_STATE_MISSING',
    });
    const features = path.join(p, '.automaker', 'features');
    await fs.mkdir(features, { recursive: true });
    expect(await inspectProjectFeatures(p)).toMatchObject({ complete: true, features: [] });
    const f = path.join(features, 'f');
    await fs.mkdir(f);
    await fs.writeFile(path.join(f, 'feature.json'), '{bad');
    expect(await inspectProjectFeatures(p)).toMatchObject({
      complete: false,
      reason: 'FEATURE_STATE_INCOMPLETE',
    });
    expect(await fs.readFile(path.join(f, 'feature.json'), 'utf8')).toBe('{bad');
    await fs.chmod(features, 0);
    restore.push(features);
    expect(await inspectProjectFeatures(p)).toMatchObject({
      complete: false,
      reason: 'FEATURE_STATE_UNREADABLE',
    });
  });
  it('counts unavailable and unknown projects as errors, never healthy zero-work projects', async () => {
    const a = await directory('a'),
      b = path.join(root, 'missing'),
      c = await directory('unknown');
    await fs.mkdir(path.join(a, '.automaker', 'features'), { recursive: true });
    const refs = [
      { id: 'a', name: 'A', path: a },
      { id: 'b', name: 'B', path: b },
      { id: 'c', name: 'C', path: c },
    ];
    const app = express();
    app.get(
      '/overview',
      createOverviewHandler(
        {
          getAll: vi.fn(() => {
            throw Error('MUTATING_LOADER_FORBIDDEN');
          }),
        } as never,
        {
          getRunningAgents: async () => [],
          getStatusForProject: async () => ({ isAutoLoopRunning: false }),
        } as never,
        { getGlobalSettings: async () => ({ projects: refs }) } as never,
        { getNotifications: async () => [] } as never
      )
    );
    const response = await request(app).get('/overview');
    expect(response.status).toBe(200);
    expect(response.body.aggregate.projectCounts).toMatchObject({
      total: 3,
      idle: 1,
      withErrors: 2,
    });
    expect(response.body.projects[1]).toMatchObject({
      availability: 'unavailable',
      availabilityReason: 'PROJECT_PATH_MISSING',
      featureCountsKnown: false,
    });
    expect(response.body.projects[2]).toMatchObject({
      featureState: 'unknown',
      featureCountsKnown: false,
    });
    expect(response.body.featureCountsComplete).toBe(false);
    await expect(fs.stat(b)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

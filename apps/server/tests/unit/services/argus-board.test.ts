import { afterEach, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { ArgusBoardProjector } from '../../../src/services/argus/board-projector.js';
import { createFeaturesRoutes } from '../../../src/routes/features/index.js';
import { FeatureLoader } from '../../../src/services/feature-loader.js';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});
it('projects phases to existing dynamic lanes and requires merge plus local sync for verified', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'board-'));
  roots.push(root);
  const features = new FeatureLoader();
  const projector = new ArgusBoardProjector(features);
  const task = {
    taskId: 'task',
    featureId: 'argus-task',
    title: 'task',
    dependencies: [],
    phase: 'loki-gate',
  } as any;
  await projector.project(root, task);
  expect((await features.get(root, 'argus-task'))?.status).toBe('pipeline_argus-loki');
  for (const [phase, status] of [
    ['ci-check', 'pipeline_argus-ci'],
    ['senior-review', 'pipeline_argus-senior'],
    ['merge-ready', 'pipeline_argus-merge'],
    ['blocked', 'waiting_approval'],
  ]) {
    task.phase = phase;
    expect(projector.status(task)).toBe(status);
  }
  task.phase = 'done';
  expect(projector.status(task)).not.toBe('verified');
  task.mergeCommitSha = 'a'.repeat(40);
  task.localSyncedSha = 'a'.repeat(40);
  expect(projector.status(task)).toBe('verified');
});
it('generic single/bulk edits, delete, create-overwrite and import cannot override Argus ownership', async () => {
  const features = {
    get: vi.fn(async () => ({ id: 'owned', orchestrator: 'argus' })),
    getAll: vi.fn(async () => [{ orchestrator: 'argus' }]),
    update: vi.fn(),
    delete: vi.fn(),
    create: vi.fn(),
  } as any;
  const app = express();
  app.use(express.json());
  app.use(createFeaturesRoutes(features));
  for (const [route, body] of [
    ['/update', { featureId: 'owned', updates: { status: 'verified' } }],
    ['/bulk-update', { featureIds: ['owned'], updates: { orchestrator: null } }],
    ['/delete', { featureId: 'owned' }],
    ['/create', { feature: { id: 'owned' } }],
    ['/import', { data: { features: [] } }],
  ] as const) {
    const result = await request(app)
      .post(route)
      .send({ projectPath: '/tmp', ...body });
    expect(result.status).toBe(409);
  }
  expect(features.update).not.toHaveBeenCalled();
  expect(features.delete).not.toHaveBeenCalled();
  expect(features.create).not.toHaveBeenCalled();
});

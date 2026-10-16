import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  process.env.AUTOMAKER_API_KEY = 'argus-control-fixture-key';
  process.env.AUTOMAKER_HIDE_API_KEY = 'true';
});
import request from 'supertest';
import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { authMiddleware } from '../../src/lib/auth.js';
import { createArgusRoutes } from '../../src/routes/argus/index.js';
import * as runtime from '../../src/services/argus/autonomy-runtime.js';
let root: string;
let app: express.Express;
let service: any;
let runner: any;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-control-'));
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('AUTOMAKER_DISABLE_AUTH', 'false');
  vi.stubEnv('ALLOWED_ROOT_DIRECTORY', root);
  service = {
    health: vi.fn().mockResolvedValue({ running: false }),
    getStatus: vi.fn().mockResolvedValue({
      autonomy: 'enabled',
      phase: 'idle',
      reconciliation: {},
      activeTask: null,
    }),
  };
  runner = {
    control: vi.fn().mockResolvedValue(undefined),
    requestReconcile: vi.fn().mockResolvedValue({ revision: 1 }),
    reconcile: vi.fn(),
    wake: vi.fn(),
  };
  vi.spyOn(runtime, 'getArgusAutonomyRunner').mockReturnValue(runner);
  app = express();
  app.use(express.json());
  app.use('/api', authMiddleware);
  app.use(
    '/api/argus',
    createArgusRoutes(service, undefined, {
      getGlobalSettings: async () => ({ projects: [{ id: 'p', path: root }] }),
    } as any)
  );
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});
const post = (action: string) =>
  request(app).post(`/api/argus/${action}`).set('X-API-Key', 'argus-control-fixture-key');
describe('Argus remote controls', () => {
  it('rejects unauthorized operations before filesystem/state effects', async () => {
    const response = await request(app).post('/api/argus/wake').send({ projectPath: root });
    expect(response.status).toBe(401);
    expect(service.getStatus).not.toHaveBeenCalled();
    expect(runner.requestReconcile).not.toHaveBeenCalled();
  });
  it('ignores the public disable-auth bypass in production', async () => {
    vi.stubEnv('AUTOMAKER_DISABLE_AUTH', 'true');
    expect((await request(app).post('/api/argus/wake').send({ projectPath: root })).status).toBe(
      401
    );
  });
  it.each(['pause', 'resume', 'wake', 'reconcile'])(
    'queues %s without waiting for remote execution',
    async (action) => {
      runner.reconcile.mockImplementation(() => new Promise(() => {}));
      const response = await post(action).send({ projectId: 'p' });
      expect(response.status).toBe(202);
      expect(response.body.status).toBe('queued');
      expect(runner.requestReconcile).toHaveBeenCalledWith(
        root,
        `api-${action}`,
        action === 'pause' || action === 'resume' ? action : undefined
      );
      expect(runner.reconcile).not.toHaveBeenCalled();
      expect(runner.wake).not.toHaveBeenCalled();
    }
  );
  it('rejects traversal and unregistered directories before side effects', async () => {
    expect((await post('wake').send({ projectPath: root + '/../outside' })).status).toBe(400);
    expect((await post('wake').send({ projectPath: '/tmp' })).status).toBe(404);
    expect(service.getStatus).not.toHaveBeenCalled();
    expect(runner.requestReconcile).not.toHaveBeenCalled();
  });
  it('rejects registered symlinks escaping the allowed root', async () => {
    const link = path.join(root, 'outside');
    await fs.symlink(os.tmpdir(), link);
    const isolated = express();
    isolated.use(express.json());
    isolated.use('/api', authMiddleware);
    isolated.use(
      '/api/argus',
      createArgusRoutes(service, undefined, {
        getGlobalSettings: async () => ({ projects: [{ id: 'outside', path: link }] }),
      } as any)
    );
    const response = await request(isolated)
      .post('/api/argus/wake')
      .set('X-API-Key', 'argus-control-fixture-key')
      .send({ projectId: 'outside' });
    expect(response.status).toBe(403);
    expect(service.getStatus).not.toHaveBeenCalled();
  });
  it('does not resume a paused project through wake or reconcile', async () => {
    runner.control.mockResolvedValue({
      revision: 1,
      handledRevision: 0,
      desiredAutonomy: 'paused',
    });
    expect((await post('wake').send({ projectId: 'p' })).status).toBe(409);
    expect((await post('reconcile').send({ projectId: 'p' })).status).toBe(409);
    expect(runner.requestReconcile).not.toHaveBeenCalled();
  });
  it('supports registered project status and fails closed without access configuration', async () => {
    expect(
      (
        await request(app)
          .get('/api/argus/status')
          .set('X-API-Key', 'argus-control-fixture-key')
          .query({ projectId: 'p' })
      ).status
    ).toBe(200);
    const closed = express();
    closed.use(express.json());
    closed.use('/api/argus', createArgusRoutes(service));
    expect((await request(closed).post('/api/argus/wake').send({ projectId: 'p' })).status).toBe(
      503
    );
  });
});

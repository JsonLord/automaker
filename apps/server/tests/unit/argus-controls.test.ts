import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createArgusRoutes } from '../../src/routes/argus/index.js';
import * as autonomyRuntime from '../../src/services/argus/autonomy-runtime.js';

describe('Argus Control Endpoints', () => {
  let app: express.Express;
  let mockService: any;
  let mockRunner: any;

  beforeEach(() => {
    mockService = {
      getStatus: vi.fn(),
      saveState: vi.fn(),
      health: vi.fn(),
    };

    mockRunner = {
      register: vi.fn(),
      wake: vi.fn(),
      reconcile: vi.fn(),
    };

    vi.spyOn(autonomyRuntime, 'getArgusAutonomyRunner').mockReturnValue(mockRunner);

    app = express();
    app.use(express.json());
    app.use('/api/argus', createArgusRoutes(mockService));
  });

  it('pause - should pause runner and update state', async () => {
    mockService.getStatus.mockResolvedValue({ autonomy: 'enabled', reconciliation: {} });

    const res = await request(app).post('/api/argus/pause').send({ projectPath: '/test/path' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('resume - should resume runner, update state and register/wake', async () => {
    mockService.getStatus.mockResolvedValue({ autonomy: 'paused', reconciliation: {} });

    const res = await request(app).post('/api/argus/resume').send({ projectPath: '/test/path' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockRunner.register).toHaveBeenCalledWith('/test/path');
    expect(mockRunner.wake).toHaveBeenCalledWith('/test/path', 'api-resume');
  });

  it('wake - should wake runner with reason', async () => {
    mockService.getStatus.mockResolvedValue({
      phase: 'test',
      latestStatus: 'test',
      reconciliation: {},
    });

    const res = await request(app)
      .post('/api/argus/wake')
      .send({ projectPath: '/test/path', reason: 'manual wake' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockRunner.wake).toHaveBeenCalledWith('/test/path', 'manual wake');
  });

  it('reconcile - should run reconcile', async () => {
    mockService.getStatus.mockResolvedValue({ autonomy: 'enabled', reconciliation: {} });

    const res = await request(app).post('/api/argus/reconcile').send({ projectPath: '/test/path' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockRunner.reconcile).toHaveBeenCalledWith('/test/path');
  });

  it('reconcile - paused project should return 409', async () => {
    mockService.getStatus.mockResolvedValue({ autonomy: 'paused', reconciliation: {} });

    const res = await request(app).post('/api/argus/reconcile').send({ projectPath: '/test/path' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ARGUS_PAUSED');
  });

  it('pause - unknown project should return 404', async () => {
    mockService.getStatus.mockResolvedValue(null);

    const res = await request(app).post('/api/argus/pause').send({ projectPath: '/unknown/path' });

    expect(res.status).toBe(404);
  });

  it('pause - malformed request should return 400', async () => {
    const res = await request(app).post('/api/argus/pause').send({});

    expect(res.status).toBe(400);
  });

  it('pause - unavailable runner should return 503', async () => {
    mockService.getStatus.mockResolvedValue({ autonomy: 'enabled', reconciliation: {} });
    vi.spyOn(autonomyRuntime, 'getArgusAutonomyRunner').mockReturnValue(undefined);

    const res = await request(app).post('/api/argus/pause').send({ projectPath: '/test/path' });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('ARGUS_RUNNER_UNAVAILABLE');
  });
});

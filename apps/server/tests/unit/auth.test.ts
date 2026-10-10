import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createAuthRoutes } from '../../src/routes/auth/index.js';

describe('Auth Endpoints', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthRoutes());
    vi.unstubAllEnvs();
  });

  it('status - should return generated when AUTOMAKER_API_KEY is not set', async () => {
    vi.stubEnv('AUTOMAKER_API_KEY', '');

    const res = await request(app).get('/api/auth/status');

    expect(res.status).toBe(200);
    expect(res.body.keySource).toBe('generated');
  });

  it('status - should return environment when AUTOMAKER_API_KEY is set but AUTHENTICATION_TOKEN is not', async () => {
    vi.stubEnv('AUTOMAKER_API_KEY', 'test-key');
    vi.stubEnv('AUTHENTICATION_TOKEN', '');

    const res = await request(app).get('/api/auth/status');

    expect(res.status).toBe(200);
    expect(res.body.keySource).toBe('environment');
  });

  it('status - should return environment when AUTOMAKER_API_KEY matches AUTHENTICATION_TOKEN', async () => {
    vi.stubEnv('AUTOMAKER_API_KEY', 'test-key');
    vi.stubEnv('AUTHENTICATION_TOKEN', 'test-key');

    const res = await request(app).get('/api/auth/status');

    expect(res.status).toBe(200);
    expect(res.body.keySource).toBe('environment');
  });
});

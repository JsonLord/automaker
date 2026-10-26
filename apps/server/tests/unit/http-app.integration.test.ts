import { afterAll, describe, expect, it, vi } from 'vitest';
const fixture = await vi.hoisted(async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'http-pipeline-'));
  process.env.DATA_DIR = dir;
  process.env.AUTOMAKER_API_KEY = 'http-integration-fixture';
  process.env.AUTOMAKER_HIDE_API_KEY = 'true';
  process.env.AUTOMAKER_MOCK_AGENT = 'true';
  return { dir };
});
import fs from 'node:fs/promises';
import request from 'supertest';
import { createHttpApplication } from '../../src/http-app.js';
import { createAuthRoutes } from '../../src/routes/auth/index.js';
import { authMiddleware } from '../../src/lib/auth.js';
const app = createHttpApplication({
  routes(app) {
    app.use('/api/auth', createAuthRoutes());
    app.use('/api', authMiddleware);
    app.get('/api/protected', (_req, res) => res.json({ success: true }));
    app.get('/api/fault', (_req, _res, next) => next(new SyntaxError('ordinary syntax error')));
  },
});
app.use((error: Error, _req: unknown, res: any, _next: unknown) =>
  res.status(500).json({ error: 'INTERNAL_ERROR', kind: error.name })
);
afterAll(async () => {
  await fs.rm(fixture.dir, { recursive: true, force: true });
});
describe('production HTTP transport and actual auth routes', () => {
  it('returns bounded sanitized MALFORMED_JSON on the real login route', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"secret":"fixture-sensitive-payload",');
    expect(response.status).toBe(400);
    expect(response.type).toBe('application/json');
    expect(response.body.error.code).toBe('MALFORMED_JSON');
    expect(response.text.length).toBeLessThan(300);
    for (const text of ['fixture-sensitive-payload', 'stack', '/workspace', 'SyntaxError'])
      expect(response.text).not.toContain(text);
  });
  it('valid JSON reaches real login and succeeds with the configured fixture key', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ apiKey: 'http-integration-fixture' });
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.headers['set-cookie']).toBeDefined();
  });
  it('preserves failed login and protected-route authentication', async () => {
    expect((await request(app).post('/api/auth/login').send({ apiKey: 'wrong' })).status).toBe(401);
    expect((await request(app).get('/api/protected')).status).toBe(401);
    expect((await request(app).get('/api/protected').set('X-API-Key', 'wrong')).status).toBe(403);
    expect(
      (await request(app).get('/api/protected').set('X-API-Key', 'http-integration-fixture')).status
    ).toBe(200);
  });
  it.each(['text/plain', 'application/x-www-form-urlencoded', 'application/jsonp'])(
    'retains 415 content policy for %s',
    async (contentType) => {
      const response = await request(app)
        .post('/api/auth/login')
        .set('Content-Type', contentType)
        .send('apiKey=fixture');
      expect(response.status).toBe(415);
      expect(response.type).toBe('application/json');
    }
  );
  it('does not rewrite non-parser SyntaxError to MALFORMED_JSON', async () => {
    const response = await request(app)
      .get('/api/fault')
      .set('X-API-Key', 'http-integration-fixture');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'INTERNAL_ERROR', kind: 'SyntaxError' });
  });
  it('bounds the actual 50 MB parser limit and sanitizes 413 errors', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send(' '.repeat(50 * 1024 * 1024 + 1));
    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(response.text.length).toBeLessThan(300);
  });
});

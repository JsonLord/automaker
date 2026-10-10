import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { handleApiDocs } from '../../src/api-docs.js';

describe('API Docs Documentation Endpoint', () => {
  it('should list all critical endpoints and routes', async () => {
    const app = express();
    app.get('/api-docs', handleApiDocs);

    const response = await request(app).get('/api-docs');
    expect(response.status).toBe(200);
    const endpoints = response.body.endpoints;

    const paths = endpoints.map((e: any) => e.path);

    const expectedPaths = [
      '/health',
      '/api-docs',
      '/api/auth/status',
      '/api/auth/login',
      '/api/auth/token',
      '/api/auth/logout',
      '/api/projects',
      '/api/templates/clone',
      '/api/argus/health',
      '/api/argus/status',
      '/api/argus/pause',
      '/api/argus/resume',
      '/api/argus/wake',
      '/api/argus/reconcile',
      '/api/events',
      '/api/terminal/ws',
    ];

    expectedPaths.forEach((path) => {
      expect(paths).toContain(path);
    });
  });
});

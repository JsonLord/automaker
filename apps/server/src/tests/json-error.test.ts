import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';

describe('Malformed JSON Handler', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());

    app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (err instanceof SyntaxError && 'status' in err && err.status === 400 && 'body' in err) {
        res.status(400).json({
          success: false,
          error: {
            code: 'MALFORMED_JSON',
            message: 'Invalid JSON payload received',
          }
        });
        return;
      }
      next(err);
    });

    app.post('/test', (req, res) => {
      res.json({ success: true, data: req.body });
    });
  });

  it('should return 400 JSON for malformed JSON', async () => {
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .send('{"invalid": json}');

    expect(res.status).toBe(400);
    expect(res.type).toBe('application/json');
    expect(res.body).toEqual({
      success: false,
      error: {
        code: 'MALFORMED_JSON',
        message: 'Invalid JSON payload received'
      }
    });
  });

  it('should process valid JSON normally', async () => {
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .send('{"valid": "json"}');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({ valid: 'json' });
  });
});

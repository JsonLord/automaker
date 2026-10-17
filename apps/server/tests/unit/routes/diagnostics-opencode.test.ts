import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createDiagnosticsOpencodeHandler } from '../../../src/routes/settings/routes/diagnostics-opencode.js';

// Mock child_process
vi.mock('child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    spawn: vi.fn((cmd, args) => {
      let callbacks: Record<string, (data: any) => void> = {};
      const proc = {
        stdout: {
          on: (event: string, cb: (data: any) => void) => {
            if (event === 'data') callbacks.stdout = cb;
          },
        },
        stderr: {
          on: (event: string, cb: (data: any) => void) => {
            if (event === 'data') callbacks.stderr = cb;
          },
        },
        on: (event: string, cb: (code: number) => void) => {
          if (event === 'close') {
            if (args[0] === 'models') {
              // Produce JSONL simulating CLI output
              if (callbacks.stdout)
                callbacks.stdout(Buffer.from(JSON.stringify({ id: 'test-model' })));
              cb(0);
            } else {
              cb(1);
            }
          }
        },
        kill: vi.fn(),
      };
      return proc;
    }),
  };
});

describe('Diagnostics OpenCode Handler', () => {
  it('returns models successfully', async () => {
    const handler = createDiagnosticsOpencodeHandler();
    const req = {} as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, models: [{ id: 'test-model' }] });
  });
});

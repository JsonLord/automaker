import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createDiagnosticsOpencodeHandler } from '../../../src/routes/settings/routes/diagnostics-opencode.js';

// Mock child_process
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    spawn: vi.fn((cmd, args) => {
      let callbacks: Record<string, (data: any) => void> = {};
      const proc = {
        stdout: {
          on: (event: string, cb: (data: any) => void) => {
            if (event === 'data') callbacks.stdout = cb;
          }
        },
        stderr: {
          on: (event: string, cb: (data: any) => void) => {
             if (event === 'data') callbacks.stderr = cb;
          }
        },
        on: (event: string, cb: (code: number) => void) => {
          if (event === 'close') {
            if (args[0] === 'models') {
               // Produce valid provider/model format simulating CLI output
               if (callbacks.stdout) callbacks.stdout(Buffer.from("provider/test-model\nprovider/test-model-2\n"));
               cb(0);
            } else if (args[0] === 'run') {
               if (callbacks.stdout) callbacks.stdout(Buffer.from("LOCAL_PROBE_OK\n"));
               cb(0);
            } else {
               cb(1);
            }
          }
        },
        kill: vi.fn()
      };
      return proc;
    }),
  };
});

describe('Diagnostics OpenCode Handler', () => {
  it('returns models successfully', async () => {
    const handler = createDiagnosticsOpencodeHandler();
    const req = { query: {} } as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, models: ["provider/test-model", "provider/test-model-2"] });
  });

  it('returns inference probe successfully', async () => {
    const handler = createDiagnosticsOpencodeHandler();
    const req = { query: { mode: 'inference' } } as unknown as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, result: "LOCAL_PROBE_OK" });
  });
});

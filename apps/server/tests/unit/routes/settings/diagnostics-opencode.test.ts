import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  createDiagnosticsOpencodeHandler,
  createDiagnosticsOpencodeInferenceHandler,
} from '../../../../src/routes/settings/routes/diagnostics-opencode.js';
import type { Request, Response } from 'express';
import { spawn } from 'child_process';
import EventEmitter from 'events';
import type { SettingsService } from '../../../../src/services/settings-service.js';

vi.mock('child_process');
vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined), // fix for the catch issue
  },
}));

describe('diagnostics-opencode routes', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockJson: ReturnType<typeof vi.fn>;
  let mockStatus: ReturnType<typeof vi.fn>;
  let mockSettingsService: Partial<SettingsService>;

  beforeEach(() => {
    mockJson = vi.fn();
    mockStatus = vi.fn().mockReturnValue({ json: mockJson });
    mockReq = { query: {} };
    mockRes = { status: mockStatus } as Partial<Response>;
    mockSettingsService = {
      getGlobalSettings: vi.fn().mockResolvedValue({
        phaseModels: {
          enhancementModel: {
            model: 'automaker-compatible/custom-model',
          },
        },
      }),
    };
    vi.clearAllMocks();
    delete process.env.COMPATIBLE_MODEL;
  });

  describe('createDiagnosticsOpencodeHandler', () => {
    it('returns models successfully', async () => {
      const mockProc = new EventEmitter() as any;
      mockProc.stdout = new EventEmitter();
      mockProc.stderr = new EventEmitter();
      mockProc.kill = vi.fn();

      vi.mocked(spawn).mockReturnValueOnce(mockProc);

      const handler = createDiagnosticsOpencodeHandler();
      const promise = handler(mockReq as Request, mockRes as Response);

      mockProc.stdout.emit('data', 'provider/model-1\nprovider/model-2\n');
      mockProc.emit('close', 0);

      await promise;

      expect(mockStatus).toHaveBeenCalledWith(200);
      expect(mockJson).toHaveBeenCalledWith({
        success: true,
        models: ['provider/model-1', 'provider/model-2'],
      });
    });
  });

  describe('createDiagnosticsOpencodeInferenceHandler', () => {
    it('returns 400 if configuration is missing', async () => {
      mockSettingsService = {
        getGlobalSettings: vi.fn().mockResolvedValue({}),
      };
      const handler = createDiagnosticsOpencodeInferenceHandler(
        mockSettingsService as SettingsService
      );
      await handler(mockReq as Request, mockRes as Response);

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith({
        success: false,
        error: 'MISSING_CONFIGURATION',
      });
    });

    it('resolves configured model and executes successful inference probe', async () => {
      const mockProc = new EventEmitter() as any;
      mockProc.stdout = new EventEmitter();
      mockProc.stderr = new EventEmitter();
      mockProc.kill = vi.fn();

      vi.mocked(spawn).mockReturnValueOnce(mockProc);

      const handler = createDiagnosticsOpencodeInferenceHandler(
        mockSettingsService as SettingsService
      );
      const promise = handler(mockReq as Request, mockRes as Response);

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(spawn).toHaveBeenCalledWith(
        'opencode',
        expect.arrayContaining([
          'run',
          '-m',
          'custom-model',
          '--format',
          'json',
          '--max-turns',
          '1',
        ]),
        expect.objectContaining({ cwd: expect.stringContaining('argus-diag-') })
      );

      mockProc.stdout.emit(
        'data',
        JSON.stringify({
          type: 'assistant_message',
          content: 'Here is your response: LOCAL_PROBE_OK',
        }) + '\n'
      );
      mockProc.emit('close', 0);

      await promise;

      expect(mockStatus).toHaveBeenCalledWith(200);
      expect(mockJson).toHaveBeenCalledWith({
        success: true,
        result: 'LOCAL_PROBE_OK',
      });
    });
  });
});

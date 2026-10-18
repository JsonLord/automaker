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

    it('handles empty models list', async () => {
      const mockProc = new EventEmitter() as any;
      mockProc.stdout = new EventEmitter();
      mockProc.stderr = new EventEmitter();
      mockProc.kill = vi.fn();

      vi.mocked(spawn).mockReturnValueOnce(mockProc);

      const handler = createDiagnosticsOpencodeHandler();
      const promise = handler(mockReq as Request, mockRes as Response);

      mockProc.stdout.emit('data', '\n');
      mockProc.emit('close', 0);

      await promise;

      expect(mockStatus).toHaveBeenCalledWith(500);
      expect(mockJson).toHaveBeenCalledWith({
        success: false,
        error: 'EMPTY_RESULT',
      });
    });
  });

  describe('createDiagnosticsOpencodeInferenceHandler', () => {
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

      // Need to wait slightly for getGlobalSettings to resolve
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(spawn).toHaveBeenCalledWith(
        'opencode',
        ['run', '-m', 'custom-model', '--format', 'json', 'Say "LOCAL_PROBE_OK"'],
        expect.any(Object)
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

    it('rejects malformed output format', async () => {
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

      mockProc.stdout.emit('data', 'Not JSON output\n');
      mockProc.emit('close', 0);

      await promise;

      expect(mockStatus).toHaveBeenCalledWith(500);
      expect(mockJson).toHaveBeenCalledWith({
        success: false,
        error: 'PARSE_ERROR',
      });
    });

    it('handles process errors', async () => {
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

      // Need to prevent unhandled rejection by making sure the event has a listener
      mockProc.emit('error', new Error('Spawn failed'));

      await promise;

      expect(mockStatus).toHaveBeenCalledWith(500);
      expect(mockJson).toHaveBeenCalledWith({
        success: false,
        error: 'PROCESS_ERROR',
      });
    });
  });
});

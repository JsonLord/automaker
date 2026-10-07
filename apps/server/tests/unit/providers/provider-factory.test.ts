import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProviderFactory } from '@/providers/provider-factory.js';
import { ClaudeProvider } from '@/providers/claude-provider.js';
import { CursorProvider } from '@/providers/cursor-provider.js';
import { CodexProvider } from '@/providers/codex-provider.js';
import { OpencodeProvider } from '@/providers/opencode-provider.js';
import { GeminiProvider } from '@/providers/gemini-provider.js';
import { CopilotProvider } from '@/providers/copilot-provider.js';

describe('provider-factory.ts', () => {
  let consoleSpy: any;
  let detectClaudeSpy: any;
  let detectCursorSpy: any;
  let detectCodexSpy: any;
  let detectOpencodeSpy: any;
  let detectGeminiSpy: any;
  let detectCopilotSpy: any;

  beforeEach(() => {
    consoleSpy = {
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    };

    // Avoid hitting real CLI / filesystem checks during unit tests
    detectClaudeSpy = vi
      .spyOn(ClaudeProvider.prototype, 'detectInstallation')
      .mockResolvedValue({ installed: true });
    detectCursorSpy = vi
      .spyOn(CursorProvider.prototype, 'detectInstallation')
      .mockResolvedValue({ installed: true });
    detectCodexSpy = vi
      .spyOn(CodexProvider.prototype, 'detectInstallation')
      .mockResolvedValue({ installed: true });
    detectOpencodeSpy = vi
      .spyOn(OpencodeProvider.prototype, 'detectInstallation')
      .mockResolvedValue({ installed: true });
    detectGeminiSpy = vi
      .spyOn(GeminiProvider.prototype, 'detectInstallation')
      .mockResolvedValue({ installed: true });
    detectCopilotSpy = vi
      .spyOn(CopilotProvider.prototype, 'detectInstallation')
      .mockResolvedValue({ installed: true });
  });

  afterEach(() => {
    consoleSpy.warn.mockRestore();
    detectClaudeSpy.mockRestore();
    detectCursorSpy.mockRestore();
    detectCodexSpy.mockRestore();
    detectOpencodeSpy.mockRestore();
    detectGeminiSpy.mockRestore();
    detectCopilotSpy.mockRestore();
  });

  describe('getProviderForModel', () => {
    it('should route all model requests to OpencodeProvider when enforcing opencode CLI', () => {
      const p1 = ProviderFactory.getProviderForModel('claude-opus-4-6');
      const p2 = ProviderFactory.getProviderForModel('cursor-auto');
      const p3 = ProviderFactory.getProviderForModel('gpt-5.2');

      expect(p1).toBeInstanceOf(OpencodeProvider);
      expect(p2).toBeInstanceOf(OpencodeProvider);
      expect(p3).toBeInstanceOf(OpencodeProvider);
    });
  });

  describe('getAllProviders', () => {
    it('should return array of all providers', () => {
      const providers = ProviderFactory.getAllProviders();
      expect(Array.isArray(providers)).toBe(true);
    });

    it('should include ClaudeProvider', () => {
      const providers = ProviderFactory.getAllProviders();
      const hasClaudeProvider = providers.some((p) => p instanceof ClaudeProvider);
      expect(hasClaudeProvider).toBe(true);
    });

    it('should return exactly 6 providers', () => {
      const providers = ProviderFactory.getAllProviders();
      expect(providers).toHaveLength(6);
    });

    it('should include CopilotProvider', () => {
      const providers = ProviderFactory.getAllProviders();
      const hasCopilotProvider = providers.some((p) => p instanceof CopilotProvider);
      expect(hasCopilotProvider).toBe(true);
    });

    it('should include GeminiProvider', () => {
      const providers = ProviderFactory.getAllProviders();
      const hasGeminiProvider = providers.some((p) => p instanceof GeminiProvider);
      expect(hasGeminiProvider).toBe(true);
    });

    it('should include CursorProvider', () => {
      const providers = ProviderFactory.getAllProviders();
      const hasCursorProvider = providers.some((p) => p instanceof CursorProvider);
      expect(hasCursorProvider).toBe(true);
    });

    it('should create new instances each time', () => {
      const providers1 = ProviderFactory.getAllProviders();
      const providers2 = ProviderFactory.getAllProviders();

      expect(providers1[0]).not.toBe(providers2[0]);
    });
  });

  describe('checkAllProviders', () => {
    it('should return installation status for all providers', async () => {
      const statuses = await ProviderFactory.checkAllProviders();

      expect(statuses).toHaveProperty('claude');
    });

    it('should call detectInstallation on each provider', async () => {
      const statuses = await ProviderFactory.checkAllProviders();

      expect(statuses.claude).toHaveProperty('installed');
    });

    it('should return correct provider names as keys', async () => {
      const statuses = await ProviderFactory.checkAllProviders();
      const keys = Object.keys(statuses);

      expect(keys).toContain('claude');
      expect(keys).toContain('cursor');
      expect(keys).toContain('codex');
      expect(keys).toContain('opencode');
      expect(keys).toContain('gemini');
      expect(keys).toContain('copilot');
      expect(keys).toHaveLength(6);
    });

    it('should include cursor status', async () => {
      const statuses = await ProviderFactory.checkAllProviders();

      expect(statuses.cursor).toHaveProperty('installed');
    });
  });

  describe('getProviderByName', () => {
    it("should return ClaudeProvider for 'claude'", () => {
      const provider = ProviderFactory.getProviderByName('claude');
      expect(provider).toBeInstanceOf(ClaudeProvider);
    });

    it("should return ClaudeProvider for 'anthropic'", () => {
      const provider = ProviderFactory.getProviderByName('anthropic');
      expect(provider).toBeInstanceOf(ClaudeProvider);
    });

    it("should return CursorProvider for 'cursor'", () => {
      const provider = ProviderFactory.getProviderByName('cursor');
      expect(provider).toBeInstanceOf(CursorProvider);
    });

    it('should be case-insensitive', () => {
      const provider1 = ProviderFactory.getProviderByName('CLAUDE');
      const provider2 = ProviderFactory.getProviderByName('ANTHROPIC');
      const provider3 = ProviderFactory.getProviderByName('CURSOR');

      expect(provider1).toBeInstanceOf(ClaudeProvider);
      expect(provider2).toBeInstanceOf(ClaudeProvider);
      expect(provider3).toBeInstanceOf(CursorProvider);
    });

    it('should return null for unknown provider', () => {
      const provider = ProviderFactory.getProviderByName('unknown');
      expect(provider).toBeNull();
    });

    it('should return null for empty string', () => {
      const provider = ProviderFactory.getProviderByName('');
      expect(provider).toBeNull();
    });

    it('should create new instance each time', () => {
      const provider1 = ProviderFactory.getProviderByName('claude');
      const provider2 = ProviderFactory.getProviderByName('claude');

      expect(provider1).not.toBe(provider2);
      expect(provider1).toBeInstanceOf(ClaudeProvider);
      expect(provider2).toBeInstanceOf(ClaudeProvider);
    });
  });

  describe('getAllAvailableModels', () => {
    it('should return array of models', () => {
      const models = ProviderFactory.getAllAvailableModels();
      expect(Array.isArray(models)).toBe(true);
    });

    it('should include models from all providers', () => {
      const models = ProviderFactory.getAllAvailableModels();
      expect(models.length).toBeGreaterThan(0);
    });

    it('should return models with required fields', () => {
      const models = ProviderFactory.getAllAvailableModels();

      models.forEach((model) => {
        expect(model).toHaveProperty('id');
        expect(model).toHaveProperty('name');
        expect(typeof model.id).toBe('string');
        expect(typeof model.name).toBe('string');
      });
    });

    it('should include Claude models', () => {
      const models = ProviderFactory.getAllAvailableModels();

      // Claude models should include claude-* in their IDs
      const hasClaudeModels = models.some((m) => m.id.toLowerCase().includes('claude'));

      expect(hasClaudeModels).toBe(true);
    });

    it('should include Cursor models', () => {
      const models = ProviderFactory.getAllAvailableModels();

      // Cursor models should include cursor provider
      const hasCursorModels = models.some((m) => m.provider === 'cursor');

      expect(hasCursorModels).toBe(true);
    });
  });
});

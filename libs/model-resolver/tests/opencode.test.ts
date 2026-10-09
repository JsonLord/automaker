import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveOpenCodeModel, resolveModelString, resolvePhaseModel } from '../src/index.js';

afterEach(() => vi.unstubAllEnvs());
const env = {
  COMPATIBLE_URL: 'https://example.test/v1',
  COMPATIBLE_MODEL: 'MiniMax-M2.7',
  COMPATIBLE_API_KEY: 'secret',
};

describe('OpenCode model identity', () => {
  it('migrates the production bare model without changing native selections', () => {
    expect(resolveOpenCodeModel('MiniMax-M2.7', undefined, env)).toEqual({
      provider: 'automaker-compatible',
      model: 'MiniMax-M2.7',
      id: 'automaker-compatible/MiniMax-M2.7',
    });
    for (const model of [
      'opencode/MiniMax-M2.7',
      'openrouter/anthropic/claude-sonnet',
      'opencode-big-pickle',
    ]) {
      expect(resolveOpenCodeModel(model, undefined, env).id).toBe(
        model.replace(/^opencode-/, 'opencode/')
      );
    }
    expect(resolveOpenCodeModel('MiniMax-M2.7', 'opencode', env).id).toBe('opencode/MiniMax-M2.7');
    expect(resolveOpenCodeModel('opencode-MiniMax-M2.7', undefined, env).id).toBe(
      'opencode/MiniMax-M2.7'
    );
  });

  it('does not infer a managed provider from an incomplete environment', () => {
    expect(
      resolveOpenCodeModel('MiniMax-M2.7', undefined, { COMPATIBLE_MODEL: 'MiniMax-M2.7' }).id
    ).toBe('opencode/MiniMax-M2.7');
  });

  it('keeps structured managed selections canonical, including nested model IDs', () => {
    expect(resolveOpenCodeModel('vendor/model', 'automaker-compatible', env).id).toBe(
      'automaker-compatible/vendor/model'
    );
    expect(resolveOpenCodeModel('auto', 'automaker-compatible-provider', env).id).toBe(
      'automaker-compatible/MiniMax-M2.7'
    );
    expect(resolveOpenCodeModel('automaker-compatible/MiniMax-M2.7', undefined, env).id).toBe(
      'automaker-compatible/MiniMax-M2.7'
    );
    expect(() => resolveOpenCodeModel('automaker-compatible/', undefined, env)).toThrow(
      'OPENCODE_MODEL_NOT_CONFIGURED'
    );
  });

  it('resolves persisted phases while preserving explicit Claude aliases and native IDs', () => {
    Object.entries(env).forEach(([name, value]) => vi.stubEnv(name, value));
    expect(
      resolvePhaseModel({ model: 'MiniMax-M2.7', providerId: 'automaker-compatible' })
    ).toMatchObject({
      model: 'automaker-compatible/MiniMax-M2.7',
      providerId: 'automaker-compatible',
    });
    expect(resolvePhaseModel('MiniMax-M2.7').model).toBe('automaker-compatible/MiniMax-M2.7');
    expect(resolveModelString('claude-sonnet')).toContain('claude-sonnet');
    expect(resolveModelString('openrouter/anthropic/claude-sonnet')).toBe(
      'openrouter/anthropic/claude-sonnet'
    );
    expect(
      resolvePhaseModel({ model: 'opencode/MiniMax-M2.7', providerId: 'opencode' }).model
    ).toBe('opencode/MiniMax-M2.7');
  });
});

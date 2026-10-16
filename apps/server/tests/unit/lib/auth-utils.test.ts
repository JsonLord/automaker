import { EventEmitter } from 'node:events';
import { spawn } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthRateLimiter,
  AuthSessionManager,
  createSecureAuthEnv,
  createTempEnvOverride,
  safeGetEnv,
  spawnSecureAuth,
  validateApiKey,
  wouldModifyEnv,
} from '@/lib/auth-utils.js';

vi.mock('child_process', () => ({ spawn: vi.fn() }));
vi.mock('@automaker/utils', () => ({
  createLogger: () => ({ debug: vi.fn() }),
}));

const anthropicKey = 'sk-ant-fixture-authentication-key';
const openaiKey = 'sk-fixture-authentication-key';

function mockChild(withStreams = true) {
  const child = Object.assign(new EventEmitter(), {
    stdout: withStreams ? new EventEmitter() : null,
    stderr: withStreams ? new EventEmitter() : null,
    kill: vi.fn().mockReturnValue(true),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return child;
}

beforeEach(() => {
  AuthSessionManager.cleanup();
});

afterEach(() => {
  AuthSessionManager.cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('API key validation and isolated environments', () => {
  it.each([
    ['anthropic', anthropicKey],
    ['openai', openaiKey],
    ['cursor', 'cursor-fixture-key'],
  ] as const)(
    'normalizes a valid %s key without changing the global environment',
    (provider, key) => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'global-anthropic-fixture');
      vi.stubEnv('OPENAI_API_KEY', 'global-openai-fixture');

      expect(validateApiKey(`  ${key}\n`, provider)).toEqual({
        isValid: true,
        normalizedKey: key,
      });
      expect(process.env.ANTHROPIC_API_KEY).toBe('global-anthropic-fixture');
      expect(process.env.OPENAI_API_KEY).toBe('global-openai-fixture');
    }
  );

  it.each(['', '  ', undefined, 42])('rejects missing or non-string keys (%s)', (key) => {
    expect(validateApiKey(key as string, 'anthropic')).toEqual({
      isValid: false,
      error: 'API key is required',
    });
  });

  it.each([
    ['anthropic', 'wrong-provider-fixture-key', 'format'],
    ['anthropic', 'sk-ant-short', 'too short'],
    ['openai', 'wrong-provider-fixture-key', 'format'],
    ['openai', 'sk-short', 'too short'],
    ['cursor', 'short', 'too short'],
  ] as const)(
    'rejects invalid %s credentials before launching authentication',
    (provider, key, error) => {
      expect(validateApiKey(key, provider)).toMatchObject({ isValid: false });
      expect(() => createSecureAuthEnv('api_key', key, provider)).toThrow(error);
      expect(spawn).not.toHaveBeenCalled();
    }
  );

  it('gives concurrent CLI and API authentication separate provider environments', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'global-anthropic-fixture');
    vi.stubEnv('OPENAI_API_KEY', 'global-openai-fixture');
    vi.stubEnv('AUTH_UTILS_INHERITED_FIXTURE', 'inherited');

    const cliAnthropic = createSecureAuthEnv('cli');
    const cliOpenai = createSecureAuthEnv('cli', undefined, 'openai');
    const apiAnthropic = createSecureAuthEnv('api_key', ` ${anthropicKey} `);
    const apiOpenai = createSecureAuthEnv('api_key', ` ${openaiKey} `, 'openai');

    expect(cliAnthropic.ANTHROPIC_API_KEY).toBeUndefined();
    expect(cliAnthropic.OPENAI_API_KEY).toBe('global-openai-fixture');
    expect(cliOpenai.OPENAI_API_KEY).toBeUndefined();
    expect(cliOpenai.ANTHROPIC_API_KEY).toBe('global-anthropic-fixture');
    expect(apiAnthropic.ANTHROPIC_API_KEY).toBe(anthropicKey);
    expect(apiOpenai.OPENAI_API_KEY).toBe(openaiKey);
    expect(apiOpenai.AUTH_UTILS_INHERITED_FIXTURE).toBe('inherited');
    apiAnthropic.AUTH_UTILS_INHERITED_FIXTURE = 'changed-in-one-environment';
    expect(apiOpenai.AUTH_UTILS_INHERITED_FIXTURE).toBe('inherited');
    expect(process.env.AUTH_UTILS_INHERITED_FIXTURE).toBe('inherited');
    expect(process.env.ANTHROPIC_API_KEY).toBe('global-anthropic-fixture');
    expect(process.env.OPENAI_API_KEY).toBe('global-openai-fixture');
  });

  it('preserves an inherited environment when API credentials are omitted', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'global-anthropic-fixture');
    expect(createSecureAuthEnv('api_key').ANTHROPIC_API_KEY).toBe('global-anthropic-fixture');
  });

  it('restores overwritten, deleted, and newly introduced variables after a temporary override', () => {
    vi.stubEnv('AUTH_UTILS_EXISTING_FIXTURE', 'original');
    vi.stubEnv('AUTH_UTILS_DELETED_FIXTURE', 'restore-me');
    vi.stubEnv('AUTH_UTILS_NEW_FIXTURE', undefined);
    vi.stubEnv('AUTH_UTILS_LATER_FIXTURE', undefined);
    const cleanup = createTempEnvOverride({
      AUTH_UTILS_EXISTING_FIXTURE: 'temporary',
      AUTH_UTILS_NEW_FIXTURE: 'temporary-new',
    });
    try {
      expect(safeGetEnv('AUTH_UTILS_EXISTING_FIXTURE')).toBe('temporary');
      expect(wouldModifyEnv('AUTH_UTILS_EXISTING_FIXTURE', 'temporary')).toBe(false);
      expect(wouldModifyEnv('AUTH_UTILS_EXISTING_FIXTURE', 'different')).toBe(true);
      delete process.env.AUTH_UTILS_DELETED_FIXTURE;
      process.env.AUTH_UTILS_LATER_FIXTURE = 'created-after-override';
    } finally {
      cleanup();
    }

    expect(safeGetEnv('AUTH_UTILS_EXISTING_FIXTURE')).toBe('original');
    expect(safeGetEnv('AUTH_UTILS_DELETED_FIXTURE')).toBe('restore-me');
    expect(safeGetEnv('AUTH_UTILS_NEW_FIXTURE')).toBeUndefined();
    expect(safeGetEnv('AUTH_UTILS_LATER_FIXTURE')).toBeUndefined();
    expect(wouldModifyEnv('AUTH_UTILS_NEW_FIXTURE', 'new-value')).toBe(true);
  });
});

describe('secure authentication process lifecycle', () => {
  it('uses the supplied environment and cwd without invoking a shell, collecting both streams', async () => {
    vi.useFakeTimers();
    const child = mockChild();
    const env = { AUTH_UTILS_PROCESS_FIXTURE: 'child-only' };
    const result = spawnSecureAuth('fixture-auth', ['login', 'literal;argument'], env, {
      cwd: '/tmp/fixture-auth',
      timeout: 100,
    });

    expect(spawn).toHaveBeenCalledWith('fixture-auth', ['login', 'literal;argument'], {
      cwd: '/tmp/fixture-auth',
      env,
      stdio: 'pipe',
      shell: false,
    });
    child.stdout?.emit('data', Buffer.from('first '));
    child.stdout?.emit('data', 'second');
    child.stderr?.emit('data', Buffer.from('diagnostic'));
    child.emit('close', 7);

    await expect(result).resolves.toEqual({
      stdout: 'first second',
      stderr: 'diagnostic',
      exitCode: 7,
    });
    await vi.advanceTimersByTimeAsync(101);
    expect(child.kill).not.toHaveBeenCalled();
    expect(process.env.AUTH_UTILS_PROCESS_FIXTURE).toBeUndefined();
  });

  it('handles a process closed by a signal with no output streams', async () => {
    const child = mockChild(false);
    const result = spawnSecureAuth('fixture-auth', [], {});
    expect(vi.mocked(spawn).mock.calls[0][2]).toMatchObject({ cwd: process.cwd() });
    child.emit('close', null);
    await expect(result).resolves.toEqual({ stdout: '', stderr: '', exitCode: null });
  });

  it('rejects startup errors and clears the pending timeout', async () => {
    vi.useFakeTimers();
    const child = mockChild();
    const result = spawnSecureAuth('missing-fixture-auth', [], {}, { timeout: 50 });
    const assertion = expect(result).rejects.toThrow('ENOENT fixture executable');
    child.emit('error', new Error('ENOENT fixture executable'));
    child.emit('close', -1);
    await assertion;
    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('terminates a timed out child once and ignores late close/error events', async () => {
    vi.useFakeTimers();
    const child = mockChild();
    const result = spawnSecureAuth('fixture-auth', [], {}, { timeout: 50 });
    const assertion = expect(result).rejects.toThrow('Authentication process timed out');
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');

    child.emit('close', 0);
    child.emit('error', new Error('late fixture error'));
    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps an already resolved exit result when a late process error arrives', async () => {
    vi.useFakeTimers();
    const child = mockChild();
    const result = spawnSecureAuth('fixture-auth', [], {}, { timeout: 50 });
    child.emit('close', 0);
    child.emit('error', new Error('late fixture error'));
    await expect(result).resolves.toEqual({ stdout: '', stderr: '', exitCode: 0 });
    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe('authentication sessions', () => {
  it('keeps session credentials separate and removes only the destroyed session', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'global-anthropic-fixture');
    const first = AuthSessionManager.createSession('first', 'api_key', anthropicKey);
    const second = AuthSessionManager.createSession('second', 'cli');

    expect(AuthSessionManager.getSession('first')?.ANTHROPIC_API_KEY).toBe(anthropicKey);
    expect(AuthSessionManager.getSession('second')?.ANTHROPIC_API_KEY).toBeUndefined();
    first.AUTH_UTILS_SESSION_FIXTURE = 'first-only';
    expect(second.AUTH_UTILS_SESSION_FIXTURE).toBeUndefined();
    AuthSessionManager.destroySession('first');
    expect(AuthSessionManager.getSession('first')).toBeUndefined();
    expect(AuthSessionManager.getSession('second')).toBe(second);
    expect(process.env.ANTHROPIC_API_KEY).toBe('global-anthropic-fixture');
    AuthSessionManager.cleanup();
    expect(AuthSessionManager.getSession('second')).toBeUndefined();
  });

  it('does not replace a session when new credentials fail validation', () => {
    const existing = AuthSessionManager.createSession('session', 'api_key', anthropicKey);
    expect(() => AuthSessionManager.createSession('session', 'api_key', 'invalid')).toThrow();
    expect(AuthSessionManager.getSession('session')).toBe(existing);
  });
});

describe('authentication attempt rate limits', () => {
  it('limits each identity separately and does not extend a window for rejected attempts', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T10:00:00Z'));
    const limiter = new AuthRateLimiter(2, 1000);
    const startedAt = Date.now();

    expect(limiter.getRemainingAttempts('alice')).toBe(2);
    expect(limiter.getResetTime('alice')).toBeNull();
    expect(limiter.canAttempt('alice')).toBe(true);
    expect(limiter.getRemainingAttempts('alice')).toBe(1);
    vi.advanceTimersByTime(100);
    expect(limiter.canAttempt('alice')).toBe(true);
    expect(limiter.getRemainingAttempts('alice')).toBe(0);
    const reset = new Date(startedAt + 1100);
    expect(limiter.getResetTime('alice')).toEqual(reset);

    vi.advanceTimersByTime(900);
    expect(limiter.canAttempt('alice')).toBe(false);
    expect(limiter.getResetTime('alice')).toEqual(reset);
    expect(limiter.canAttempt('bob')).toBe(true);
    expect(limiter.getRemainingAttempts('bob')).toBe(1);
    vi.advanceTimersByTime(100);
    expect(limiter.canAttempt('alice')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(limiter.canAttempt('alice')).toBe(true);
    expect(limiter.getRemainingAttempts('alice')).toBe(1);
    expect(limiter.getRemainingAttempts('bob')).toBe(1);
  });

  it('applies the default attempt budget', () => {
    const limiter = new AuthRateLimiter();
    expect(limiter.getRemainingAttempts('default')).toBe(5);
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(limiter.canAttempt('default')).toBe(true);
    }
    expect(limiter.canAttempt('default')).toBe(false);
    expect(limiter.getRemainingAttempts('default')).toBe(0);
  });
});

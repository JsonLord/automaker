import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyError,
  createErrorResponse,
  createRetryHandler,
  ErrorSeverity,
  ErrorType,
  getUserFriendlyErrorMessage,
  isAuthenticationError,
  isBillingError,
  isRateLimitError,
  isRetryableError,
  logError,
  ProviderErrorHandler,
} from '../../../src/lib/error-handler.js';

const logger = vi.hoisted(() => ({ error: vi.fn(), debug: vi.fn() }));
vi.mock('@automaker/utils', () => ({ createLogger: () => logger }));

afterEach(() => vi.useRealTimers());

describe('provider error policy', () => {
  it.each([
    ['invalid_api_key', ErrorType.AUTHENTICATION, false],
    ['insufficient credit', ErrorType.BILLING, false],
    ['429 too many requests', ErrorType.RATE_LIMIT, true],
    ['ECONNREFUSED', ErrorType.NETWORK, true],
    ['operation aborted', ErrorType.TIMEOUT, true],
    ['403 forbidden', ErrorType.PERMISSION, false],
    ['command not found', ErrorType.CLI_NOT_FOUND, false],
    ['unknown model', ErrorType.MODEL_NOT_SUPPORTED, false],
    ['503 internal server error', ErrorType.SERVER_ERROR, true],
    ['an unfamiliar failure', ErrorType.UNKNOWN, true],
  ])('classifies %s with the correct retry policy', (message, type, retryable) => {
    expect(classifyError(new Error(message), 'codex', { taskId: 'task-a' })).toMatchObject({
      type,
      retryable,
      provider: 'codex',
      technicalMessage: message,
      context: { taskId: 'task-a' },
    });
  });

  it.each([
    [{ message: 'invalid api key' }, 'invalid api key'],
    [{ error: { message: 'payment required' } }, 'payment required'],
    [{ error: 'token revoked' }, 'token revoked'],
    [{ error: { code: 'unexpected' } }, '{"code":"unexpected"}'],
    [{ code: 123 }, '{"code":123}'],
    [null, 'null'],
    [undefined, 'undefined'],
    [42, '42'],
  ])('preserves structured evidence while classifying it', (input, technicalMessage) => {
    expect(classifyError(input).technicalMessage).toBe(technicalMessage);
  });

  it('returns a safe client response with actionable authentication guidance', () => {
    const evidence = 'invalid api key: test-only-sensitive-value';
    const response = createErrorResponse(evidence, 'claude', { taskId: 'task-a' });
    expect(response).toMatchObject({
      success: false,
      errorType: ErrorType.AUTHENTICATION,
      severity: ErrorSeverity.HIGH,
      retryable: false,
    });
    expect(response.suggestedAction).toContain('Verify your API key');
    expect(JSON.stringify(response)).not.toContain('test-only-sensitive-value');
    expect(getUserFriendlyErrorMessage(evidence, 'claude')).toMatch(/^\[CLAUDE\]/);
    expect(getUserFriendlyErrorMessage(evidence)).not.toContain('[CLAUDE]');
  });

  it.each(['claude', 'codex', 'cursor'] as const)(
    'keeps %s error shortcuts consistent with fatal authentication, billing, and retryable rate limits',
    (provider) => {
      const handler = ProviderErrorHandler[provider];
      expect(handler.classify('unauthorized')).toMatchObject({
        provider,
        type: ErrorType.AUTHENTICATION,
        retryable: false,
      });
      expect(handler.getUserMessage('quota exceeded')).toContain(`[${provider.toUpperCase()}]`);
      expect(handler.isAuth('token revoked')).toBe(true);
      expect(handler.isAuth('network')).toBe(false);
      expect(handler.isBilling('payment required')).toBe(true);
      expect(handler.isBilling('network')).toBe(false);
      expect(handler.isRateLimit('429')).toBe(true);
      expect(handler.isRateLimit('network')).toBe(false);
    }
  );

  it('exposes common policy predicates and diagnostic context', () => {
    expect(isAuthenticationError('unauthorized')).toBe(true);
    expect(isBillingError('insufficient credit')).toBe(true);
    expect(isRateLimitError('too many requests')).toBe(true);
    expect(isRetryableError('forbidden')).toBe(false);
    expect(isRetryableError('network')).toBe(true);
    logError('forbidden', 'codex', 'dispatch', { taskId: 'task-a' });
    expect(logger.error).toHaveBeenLastCalledWith(
      'Error in codex during dispatch',
      expect.objectContaining({
        type: ErrorType.PERMISSION,
        context: { operation: 'dispatch', taskId: 'task-a' },
      })
    );
    logError('unfamiliar');
    expect(logger.error.mock.calls.at(-1)?.[0]).toBe('Error in unknown');
  });
});

describe('provider retries', () => {
  it('retries temporary failures with bounded exponential delays and returns the first success', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValue('ready');
    const result = createRetryHandler(3, 100)(operation);
    expect(operation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(operation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(operation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(operation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('ready');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('does not retry invalid credentials or spend the retry budget on permanent failures', async () => {
    vi.useFakeTimers();
    const failure = new Error('unauthorized');
    const operation = vi.fn().mockRejectedValue(failure);
    await expect(createRetryHandler()(operation)).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops after the configured budget and preserves the last error', async () => {
    vi.useFakeTimers();
    const failure = new Error('custom transient');
    const operation = vi.fn().mockRejectedValue(failure);
    const policy = vi.fn().mockReturnValue(true);
    const result = createRetryHandler(2, 1)(operation, policy);
    const assertion = expect(result).rejects.toBe(failure);
    await vi.runAllTimersAsync();
    await assertion;
    expect(operation).toHaveBeenCalledTimes(3);
    expect(policy).toHaveBeenCalledTimes(2);
  });
});

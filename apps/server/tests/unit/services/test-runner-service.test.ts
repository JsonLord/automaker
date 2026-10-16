import { EventEmitter } from 'node:events';
import { execSync, spawn } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as secureFs from '@/lib/secure-fs.js';
import { getTestRunnerService, TestRunnerService } from '@/services/test-runner-service.js';

vi.mock('child_process', () => ({ spawn: vi.fn(), execSync: vi.fn() }));
vi.mock('@/lib/secure-fs.js', () => ({ access: vi.fn() }));
vi.mock('@automaker/utils', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;

function makeChild(pid = 12345, withStreams = true) {
  const child = Object.assign(new EventEmitter(), {
    stdout: withStreams ? new EventEmitter() : null,
    stderr: withStreams ? new EventEmitter() : null,
    pid,
    killed: false,
  });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  return child;
}

let service: TestRunnerService;
let emitter: { emit: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-15T10:00:00Z'));
  vi.mocked(secureFs.access).mockResolvedValue(undefined);
  vi.spyOn(process, 'kill').mockReturnValue(true);
  service = new TestRunnerService();
  emitter = { emit: vi.fn(), subscribe: vi.fn() };
  service.setEventEmitter(emitter);
});

afterEach(async () => {
  await service.cleanup();
  await getTestRunnerService().cleanup();
  Object.defineProperty(process, 'platform', platformDescriptor);
  vi.useRealTimers();
});

async function start(worktreePath = '/repo/worktree', testFile?: string) {
  const pending = service.startTests(worktreePath, { command: 'npm test', testFile });
  await vi.advanceTimersByTimeAsync(200);
  const result = await pending;
  expect(result.success).toBe(true);
  return result.result!;
}

describe('test runner startup and ownership', () => {
  it('rejects missing worktrees and empty commands without spawning', async () => {
    vi.mocked(secureFs.access).mockRejectedValueOnce(new Error('ENOENT fixture worktree'));
    await expect(service.startTests('/missing', { command: 'npm test' })).resolves.toMatchObject({
      success: false,
      error: 'Worktree path does not exist: /missing',
    });
    await expect(service.startTests('/repo', { command: '' })).resolves.toMatchObject({
      success: false,
      error: 'No test command provided',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('starts a configured shell command with an isolated child environment and a sanitized file argument', async () => {
    makeChild();
    const result = await start('/repo/worktree', 'tests/unit.test.ts;$(echo bad)');
    expect(result).toMatchObject({
      worktreePath: '/repo/worktree',
      command: 'npm test -- tests/unit.test.tsechobad',
      status: 'running',
      testFile: 'tests/unit.test.ts;$(echo bad)',
    });
    expect(spawn).toHaveBeenCalledWith('npm test -- tests/unit.test.tsechobad', [], {
      cwd: '/repo/worktree',
      env: expect.objectContaining({
        FORCE_COLOR: '1',
        COLORTERM: 'truecolor',
        TERM: 'xterm-256color',
        CI: 'true',
      }),
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    expect(vi.mocked(spawn).mock.calls[0][2]?.env).not.toBe(process.env);
    expect(service.isRunning('/repo/worktree')).toBe(true);
    expect(service.getActiveSession('/repo/worktree')?.id).toBe(result.sessionId);
    expect(emitter.emit).toHaveBeenCalledWith(
      'test-runner:started',
      expect.objectContaining({
        sessionId: result.sessionId,
      })
    );
  });

  it('rejects a second active run in the same worktree while allowing a different worktree', async () => {
    makeChild(1001);
    const first = await start('/repo/one');
    await expect(service.startTests('/repo/one', { command: 'npm test' })).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining(first.sessionId),
    });
    makeChild(1002);
    await start('/repo/two');
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(service.listSessions().result.sessions).toHaveLength(2);
  });

  it('allows only one concurrent startup for a worktree across asynchronous filesystem validation', async () => {
    makeChild(1001);
    makeChild(1002);
    const first = service.startTests('/repo/one', { command: 'npm test' });
    const second = service.startTests('/repo/one', { command: 'npm test' });
    await vi.advanceTimersByTimeAsync(200);
    const results = await Promise.all([first, second]);
    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(service.listSessions('/repo/one').result.sessions).toHaveLength(1);
  });
});

describe('test output streaming and completion', () => {
  it('combines stdout and stderr in order while throttling streaming output', async () => {
    const child = makeChild();
    const { sessionId } = await start();
    emitter.emit.mockClear();
    child.stdout?.emit('data', Buffer.from('first\n'));
    child.stderr?.emit('data', Buffer.from('warning\n'));
    expect(service.getSessionOutput(sessionId).result).toMatchObject({
      output: 'first\nwarning\n',
      status: 'running',
      finishedAt: null,
    });
    expect(emitter.emit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(99);
    expect(emitter.emit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(emitter.emit).toHaveBeenCalledExactlyOnceWith(
      'test-runner:output',
      expect.objectContaining({
        sessionId,
        content: 'first\nwarning\n',
      })
    );
  });

  it('caps replay history at 50,000 characters and delivers large output in bounded batches', async () => {
    const child = makeChild();
    const { sessionId } = await start();
    emitter.emit.mockClear();
    const content = `${'old'.repeat(20000)}latest`;
    child.stdout?.emit('data', Buffer.from(content));
    expect(service.getSessionOutput(sessionId).result?.output).toBe(content.slice(-50000));
    await vi.advanceTimersByTimeAsync(1000);
    const batches = emitter.emit.mock.calls.filter(([event]) => event === 'test-runner:output');
    expect(batches).toHaveLength(Math.ceil(content.length / 8192));
    expect(batches.every(([, payload]) => payload.content.length <= 8192)).toBe(true);
    expect(batches.map(([, payload]) => payload.content).join('')).toBe(content);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [0, 'passed'],
    [1, 'failed'],
    [null, 'failed'],
  ] as const)(
    'flushes final output before completion and records exit %s as %s',
    async (code, status) => {
      const child = makeChild();
      const { sessionId } = await start();
      emitter.emit.mockClear();
      child.stdout?.emit('data', Buffer.from('last result\n'));
      await vi.advanceTimersByTimeAsync(50);
      child.emit('exit', code);
      expect(emitter.emit.mock.calls.map(([event]) => event)).toEqual([
        'test-runner:output',
        'test-runner:completed',
      ]);
      expect(emitter.emit).toHaveBeenLastCalledWith(
        'test-runner:completed',
        expect.objectContaining({
          sessionId,
          status,
          exitCode: code,
          duration: 250,
        })
      );
      expect(service.getSessionOutput(sessionId).result).toMatchObject({
        status,
        finishedAt: new Date(Date.now()).toISOString(),
        output: 'last result\n',
      });
      expect(service.isRunning('/repo/worktree')).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('records an asynchronous process error and exposes its failure evidence', async () => {
    const child = makeChild();
    const { sessionId } = await start();
    child.emit('error', new Error('fixture process unavailable'));
    expect(service.getSession(sessionId)).toMatchObject({ status: 'error', exitCode: null });
    expect(emitter.emit).toHaveBeenLastCalledWith(
      'test-runner:completed',
      expect.objectContaining({
        status: 'error',
        error: 'fixture process unavailable',
      })
    );
  });

  it('returns a startup failure for a child error during the grace period', async () => {
    const child = makeChild(12345, false);
    const pending = service.startTests('/repo/worktree', { command: 'npm test' });
    await vi.advanceTimersByTimeAsync(0);
    child.emit('error', new Error('spawn ENOENT fixture'));
    await vi.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toEqual({
      success: false,
      error: 'Failed to start tests: spawn ENOENT fixture',
    });
    expect(service.listSessions().result.sessions[0].status).toBe('error');
    expect(
      emitter.emit.mock.calls.filter(([event]) => event === 'test-runner:started')
    ).toHaveLength(0);
  });

  it('reports the actual terminal status if a quick successful run exits during startup', async () => {
    const child = makeChild();
    const pending = service.startTests('/repo/worktree', { command: 'npm test' });
    await vi.advanceTimersByTimeAsync(0);
    child.emit('exit', 0);
    await vi.advanceTimersByTimeAsync(200);
    const result = await pending;
    expect(result).toMatchObject({ success: true, result: { status: 'passed' } });
    const lifecycle = emitter.emit.mock.calls.map(([event]) => event);
    expect(lifecycle.indexOf('test-runner:started')).toBeLessThan(
      lifecycle.indexOf('test-runner:completed')
    );
  });

  it('preserves the first terminal error when the process later emits an exit', async () => {
    const child = makeChild();
    const { sessionId } = await start();
    emitter.emit.mockClear();
    child.emit('error', new Error('fixture process failure'));
    child.emit('exit', 1);
    expect(service.getSession(sessionId)?.status).toBe('error');
    expect(
      emitter.emit.mock.calls.filter(([event]) => event === 'test-runner:completed')
    ).toHaveLength(1);
  });
});

describe('test runner cancellation and retained sessions', () => {
  it('cancels a process group, clears timers, and suppresses queued/late output and duplicate completion', async () => {
    const child = makeChild();
    const { sessionId } = await start();
    child.stdout?.emit('data', Buffer.from('before stop'));
    emitter.emit.mockClear();
    await expect(service.stopTests(sessionId)).resolves.toMatchObject({ success: true });
    if (process.platform !== 'win32') {
      expect(process.kill).toHaveBeenCalledExactlyOnceWith(-12345, 'SIGTERM');
    }
    child.stdout?.emit('data', Buffer.from('after stop'));
    child.stderr?.emit('data', Buffer.from('late error output'));
    child.emit('exit', null);
    await vi.advanceTimersByTimeAsync(1000);
    expect(service.getSessionOutput(sessionId).result).toMatchObject({
      status: 'cancelled',
      output: 'before stop',
    });
    expect(emitter.emit).toHaveBeenCalledExactlyOnceWith(
      'test-runner:completed',
      expect.objectContaining({
        sessionId,
        status: 'cancelled',
      })
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falls back to the child PID if a Unix process group is unavailable and tolerates a vanished child', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    makeChild();
    const { sessionId } = await start();
    vi.mocked(process.kill).mockImplementation(() => {
      throw new Error('ESRCH fixture');
    });
    await expect(service.stopTests(sessionId)).resolves.toMatchObject({ success: true });
    expect(process.kill).toHaveBeenNthCalledWith(1, -12345, 'SIGTERM');
    expect(process.kill).toHaveBeenNthCalledWith(2, 12345, 'SIGTERM');
    expect(service.isRunning('/repo/worktree')).toBe(false);
  });

  it('uses Windows taskkill only through the mocked process adapter', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    makeChild();
    const { sessionId } = await start();
    await service.stopTests(sessionId);
    expect(execSync).toHaveBeenCalledExactlyOnceWith('taskkill /F /T /PID 12345', {
      stdio: 'ignore',
    });
    expect(process.kill).not.toHaveBeenCalled();
    expect(vi.mocked(spawn).mock.calls[0][2]).toMatchObject({ detached: false });
  });

  it('returns clear missing-session errors and treats stopping a finished session as idempotent', async () => {
    await expect(service.stopTests('missing')).resolves.toEqual({
      success: false,
      error: 'Test session not found: missing',
    });
    expect(service.getSessionOutput('missing')).toEqual({
      success: false,
      error: 'Test session not found: missing',
    });
    expect(service.getSession('missing')).toBeUndefined();
    const child = makeChild();
    const { sessionId } = await start();
    child.emit('exit', 0);
    await expect(service.stopTests(sessionId)).resolves.toMatchObject({
      success: true,
      result: { message: 'Tests already finished (status: passed)' },
    });
    expect(process.kill).not.toHaveBeenCalled();
  });

  it('lists worktrees independently and prunes only old terminal sessions', async () => {
    const finished = makeChild(1001);
    const first = await start('/repo/one');
    finished.emit('exit', 0);
    makeChild(1002);
    const second = await start('/repo/two');
    expect(service.listSessions('/repo/one').result.sessions).toEqual([
      expect.objectContaining({ sessionId: first.sessionId, status: 'passed', exitCode: 0 }),
    ]);
    expect(service.listSessions('/repo/two').result.sessions).toEqual([
      expect.objectContaining({ sessionId: second.sessionId, status: 'running', finishedAt: null }),
    ]);
    vi.advanceTimersByTime(30 * 60 * 1000);
    service.cleanupOldSessions();
    expect(service.getSession(first.sessionId)).toBeUndefined();
    expect(service.getSession(second.sessionId)?.status).toBe('running');
  });

  it('cancels all running worktrees and releases retained sessions during cleanup', async () => {
    makeChild(1001);
    await start('/repo/one');
    makeChild(1002);
    await start('/repo/two');
    await service.cancelAll();
    expect(service.listSessions().result.sessions.map((session) => session.status)).toEqual([
      'cancelled',
      'cancelled',
    ]);
    await service.cleanup();
    expect(service.listSessions().result.sessions).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(getTestRunnerService()).toBe(getTestRunnerService());
  });

  it('supports completion and cleanup without an event subscriber or process streams', async () => {
    service = new TestRunnerService();
    const child = makeChild(12345, false);
    const { sessionId } = await start();
    child.emit('exit', 0);
    expect(service.getSessionOutput(sessionId).result?.status).toBe('passed');
    expect(emitter.emit).not.toHaveBeenCalled();
    await service.cleanup();
    expect(service.listSessions().result.sessions).toEqual([]);
  });
});

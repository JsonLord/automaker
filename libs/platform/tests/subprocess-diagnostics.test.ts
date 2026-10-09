import { afterEach, expect, it, vi } from 'vitest';
import os from 'os';
import { spawnJSONLProcess, spawnProcess } from '../src/subprocess.js';

afterEach(() => vi.restoreAllMocks());

it('redacts credentials split across stderr chunks before logging and retains the exit code', async () => {
  const secret = 'fixture-split-credential';
  const logs: string[] = [];
  for (const method of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
  }
  const events: any[] = [];
  for await (const event of spawnJSONLProcess({
    command: process.execPath,
    args: [
      '-e',
      "process.stderr.write('fixture-split-');setTimeout(()=>{process.stderr.write('credential');process.exitCode=7},20)",
    ],
    cwd: os.tmpdir(),
    timeout: 10000,
    sanitizeOutput: (text) => text.replaceAll(secret, '[REDACTED]'),
  }))
    events.push(event);
  expect(events).toEqual([{ type: 'error', error: '[REDACTED]', exitCode: 7 }]);
  expect(logs.join('\n')).not.toContain(secret);
  expect(logs.some((line) => line.includes('stderr: fixture-split-'))).toBe(false);
});

it('bounds collected role stdout and stderr without returning partial credentials', async () => {
  const result = await spawnProcess({
    command: process.execPath,
    args: ['-e', "process.stdout.write('x'.repeat(1000));process.stderr.write('y'.repeat(1000))"],
    cwd: os.tmpdir(),
    maxOutputBytes: 32,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe('OpenCode stdout exceeded the diagnostic limit');
  expect(result.stderr).toBe('OpenCode stderr exceeded the diagnostic limit');
});

import { afterEach, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  DisabledInfrastructureProvider,
  StaticInfrastructureProvider,
  ForemanInfrastructureProvider,
} from '../../../src/services/argus/infrastructure.js';
import { ArgusWorkerWaves } from '../../../src/services/argus/worker-waves.js';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});
async function root() {
  const p = await fs.mkdtemp(path.join(os.tmpdir(), 'workers-'));
  dirs.push(p);
  return p;
}
const inventory = [
  {
    id: '42',
    cpu: 4,
    ramMb: 8192,
    isolated: true,
    runtimes: ['node22'],
    commands: ['npm test'],
    status: 'ready' as const,
  },
];
const requirements = {
  cpu: 2,
  ramMb: 1024,
  isolated: true,
  runtime: 'node22',
  commands: ['npm test'],
  timeLimitMs: 1000,
};
it('disabled workers are honest and do not prevent independent Jules work', async () => {
  const provider = new DisabledInfrastructureProvider();
  expect(await provider.listWorkers()).toEqual([]);
  await expect(provider.acquireWorker(requirements)).rejects.toThrow('UNAVAILABLE');
});
it('claims one worker across provider instances, monitors and releases it', async () => {
  const dir = await root();
  const a = new StaticInfrastructureProvider(inventory, dir, 'a');
  const b = new StaticInfrastructureProvider(inventory, dir, 'b');
  const results = await Promise.allSettled([
    a.acquireWorker(requirements),
    b.acquireWorker(requirements),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const winner = results[0].status === 'fulfilled' ? a : b;
  const loser = winner === a ? b : a;
  const lease = (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>)
    .value;
  expect(await winner.getWorkerStatus(lease.workerId)).toBe('ready');
  await expect(loser.releaseWorker(lease.id)).rejects.toThrow('NOT_OWNED');
  await winner.releaseWorker(lease.id);
  expect((await loser.acquireWorker(requirements)).workerId).toBe('42');
});
it('expired allocation cannot be silently stolen and disallowed commands never execute', async () => {
  const dir = await root();
  let now = 0;
  const provider = new StaticInfrastructureProvider(inventory, dir, 'a', () => now);
  const lease = await provider.acquireWorker(requirements);
  now = 1001;
  await expect(provider.acquireWorker(requirements)).rejects.toThrow('CAPACITY');
  await provider.releaseWorker(lease.id);
  await expect(
    provider.acquireWorker({ ...requirements, commands: ['destroy host'] })
  ).rejects.toThrow('CAPACITY');
});
it('Foreman is disabled by default, authenticated GET-only, allowlisted, and fails unavailable', async () => {
  const dir = await root();
  const request = vi.fn(async () => new Response(JSON.stringify({ id: 42 }), { status: 200 }));
  const disabled = new ForemanInfrastructureProvider(
    inventory,
    dir,
    'a',
    'https://foreman.example',
    'fixture-token',
    false,
    request as any
  );
  expect(await disabled.listWorkers()).toEqual([]);
  expect(request).not.toHaveBeenCalled();
  const foreman = new ForemanInfrastructureProvider(
    inventory,
    dir,
    'a',
    'https://foreman.example',
    'fixture-token',
    true,
    request as any
  );
  expect((await foreman.listWorkers())[0].status).toBe('ready');
  expect(String(request.mock.calls[0][0])).toBe('https://foreman.example/api/hosts/42');
  expect(request.mock.calls[0][1].method).toBe('GET');
  request.mockRejectedValueOnce(new Error('offline'));
  expect((await foreman.listWorkers())[0].status).toBe('unavailable');
});
it('dependency waves serialize claims, retain stale ownership on restart, and reject cycles', async () => {
  const dir = await root();
  let now = 0;
  const waves = new ArgusWorkerWaves(dir, true, 2, () => now);
  await expect(
    waves.seed([
      { id: 'a', dependencies: ['b'] },
      { id: 'b', dependencies: ['a'] },
    ])
  ).rejects.toThrow('CYCLE');
  await waves.seed([
    { id: 'a', dependencies: [] },
    { id: 'b', dependencies: ['a'] },
    { id: 'c', dependencies: [] },
  ]);
  const [a, c] = await Promise.all([waves.claim('worker-a', 1000), waves.claim('worker-c', 1000)]);
  expect(new Set([a?.id, c?.id])).toEqual(new Set(['a', 'c']));
  expect(await waves.claim('blocked')).toBeUndefined();
  await waves.finish(a!.id, a!.owner!, a!.leaseId!);
  const b = await waves.claim('worker-b', 1000);
  expect(b?.id).toBe('b');
  now = 1001;
  const restarted = new ArgusWorkerWaves(dir, true, 2, () => now);
  expect(await restarted.claim('new-worker')).toBeUndefined();
  await expect(restarted.finish(b!.id, 'worker-b', b!.leaseId!)).rejects.toThrow('NOT_CURRENT');
});
it('external experiment allocation associates a lease, releases complete jobs, and retains unknown outcomes', async () => {
  const { LeasedExperimentEvaluator } =
    await import('../../../src/services/argus/infrastructure.js');
  const dir = await root();
  const provider = new StaticInfrastructureProvider(inventory, dir, 'experiment');
  const remote = {
    evaluate: vi.fn(async (job: any) => ({
      runId: job.runId,
      headSha: job.variant.headSha,
      isolated: true,
      correctness: true,
      value: 10,
      artifact: 'fixture',
    })),
  };
  const evaluator = new LeasedExperimentEvaluator(provider, requirements, remote);
  const job = {
    runId: 'run',
    variant: { id: 'one', branch: 'one', headSha: 'a'.repeat(40) },
    commands: ['npm test'],
    timeoutMs: 1000,
  };
  await evaluator.evaluate(job);
  expect(remote.evaluate.mock.calls[0][0].worker.id).toBe('42');
  remote.evaluate.mockRejectedValueOnce(new Error('transport outcome unknown'));
  await expect(evaluator.evaluate(job)).rejects.toThrow('outcome unknown');
  await expect(provider.acquireWorker(requirements)).rejects.toThrow('CAPACITY');
});

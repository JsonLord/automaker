import path from 'path';
import crypto from 'crypto';
import { updateDurableJson } from './durable-store.js';
export interface WaveTask {
  id: string;
  dependencies: string[];
  status: 'pending' | 'claimed' | 'done' | 'cancelled' | 'stale';
  owner?: string;
  leaseId?: string;
  expiresAt?: string;
}
/** Optional claim ledger, no timer or execution loop; sequential Runner remains the default. */
export class ArgusWorkerWaves {
  constructor(
    private root: string,
    private enabled = false,
    private concurrency = 1,
    private now = () => Date.now()
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2)
      throw new Error('WAVE_CONCURRENCY_INVALID');
  }
  private file() {
    return path.join(this.root, '.automaker', 'worker-waves.json');
  }
  async seed(tasks: Array<Pick<WaveTask, 'id' | 'dependencies'>>) {
    if (!this.enabled) throw new Error('WORKER_WAVES_DISABLED');
    const ids = new Set(tasks.map((t) => t.id));
    if (
      ids.size !== tasks.length ||
      tasks.some((t) => t.dependencies.some((d) => !ids.has(d) || d === t.id))
    )
      throw new Error('WAVE_GRAPH_INVALID');
    const visited = new Set<string>(),
      visiting = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) throw new Error('WAVE_GRAPH_CYCLE');
      if (visited.has(id)) return;
      visiting.add(id);
      for (const d of tasks.find((t) => t.id === id)!.dependencies) visit(d);
      visiting.delete(id);
      visited.add(id);
    };
    tasks.forEach((t) => visit(t.id));
    return updateDurableJson<WaveTask[]>(
      this.file(),
      (current) => current || tasks.map((t) => ({ ...t, status: 'pending' }))
    );
  }
  async claim(owner: string, ttlMs = 60000) {
    if (!this.enabled) throw new Error('WORKER_WAVES_DISABLED');
    if (!owner || ttlMs < 1000 || ttlMs > 3600000) throw new Error('WORKER_CLAIM_INVALID');
    let claim: WaveTask | undefined;
    await updateDurableJson<WaveTask[]>(this.file(), (tasks) => {
      if (!tasks) throw new Error('WAVE_NOT_FOUND');
      for (const t of tasks)
        if (t.status === 'claimed' && Date.parse(t.expiresAt!) <= this.now()) t.status = 'stale';
      if (
        tasks.filter((t) => t.status === 'claimed' || t.status === 'stale').length >=
        this.concurrency
      )
        return tasks;
      const next = tasks.find(
        (t) =>
          t.status === 'pending' &&
          t.dependencies.every((d) => tasks.find((x) => x.id === d)?.status === 'done')
      );
      if (next) {
        Object.assign(next, {
          status: 'claimed',
          owner,
          leaseId: crypto.randomUUID(),
          expiresAt: new Date(this.now() + ttlMs).toISOString(),
        });
        claim = { ...next };
      }
      return tasks;
    });
    return claim;
  }
  async finish(id: string, owner: string, leaseId: string) {
    return updateDurableJson<WaveTask[]>(this.file(), (tasks) => {
      const t = tasks?.find((t) => t.id === id);
      if (
        !t ||
        t.status !== 'claimed' ||
        t.owner !== owner ||
        t.leaseId !== leaseId ||
        Date.parse(t.expiresAt!) <= this.now()
      )
        throw new Error('WORKER_CLAIM_NOT_CURRENT');
      t.status = 'done';
      return tasks!;
    });
  }
  async cancel(id: string) {
    return updateDurableJson<WaveTask[]>(this.file(), (tasks) => {
      const t = tasks?.find((t) => t.id === id);
      if (!t || t.status !== 'pending') throw new Error('WAVE_CANCEL_REQUIRES_PENDING');
      t.status = 'cancelled';
      return tasks!;
    });
  }
}

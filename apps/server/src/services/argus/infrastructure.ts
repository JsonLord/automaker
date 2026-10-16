import path from 'path';
import crypto from 'crypto';
import { updateDurableJson } from './durable-store.js';
export interface WorkerInfo {
  id: string;
  cpu: number;
  ramMb: number;
  isolated: boolean;
  runtimes: string[];
  commands: string[];
  status: 'ready' | 'unavailable';
}
export interface WorkerRequirements {
  cpu: number;
  ramMb: number;
  isolated: boolean;
  runtime: string;
  commands: string[];
  timeLimitMs: number;
}
export interface WorkerLease {
  id: string;
  workerId: string;
  owner: string;
  expiresAt: string;
  status: 'active' | 'released' | 'stale';
}
export interface InfrastructureProvider {
  listWorkers(): Promise<WorkerInfo[]>;
  acquireWorker(requirements: WorkerRequirements): Promise<WorkerLease>;
  getWorkerStatus(id: string): Promise<WorkerInfo['status']>;
  releaseWorker(id: string): Promise<void>;
}
export class DisabledInfrastructureProvider implements InfrastructureProvider {
  async listWorkers() {
    return [];
  }
  async acquireWorker(_requirements: WorkerRequirements): Promise<WorkerLease> {
    throw new Error('INFRASTRUCTURE_UNAVAILABLE');
  }
  async getWorkerStatus(_id: string) {
    return 'unavailable' as const;
  }
  async releaseWorker(_id: string) {}
}
/** Inventory and exclusive claims only. Does not expose a shell, provision, or destroy hosts. */
export class StaticInfrastructureProvider implements InfrastructureProvider {
  constructor(
    protected inventory: WorkerInfo[],
    private stateRoot: string,
    private owner: string,
    private now = () => Date.now()
  ) {}
  async listWorkers() {
    return this.inventory.map((w) => ({
      ...w,
      runtimes: [...w.runtimes],
      commands: [...w.commands],
    }));
  }
  async getWorkerStatus(id: string) {
    return (await this.listWorkers()).find((w) => w.id === id)?.status || 'unavailable';
  }
  async acquireWorker(req: WorkerRequirements) {
    if (
      !Number.isInteger(req.timeLimitMs) ||
      req.timeLimitMs < 1000 ||
      req.timeLimitMs > 3600000 ||
      !Number.isFinite(req.cpu) ||
      req.cpu <= 0 ||
      !Number.isFinite(req.ramMb) ||
      req.ramMb <= 0 ||
      !req.commands.length
    )
      throw new Error('WORKER_REQUIREMENTS_INVALID');
    const workers = await this.listWorkers();
    let acquired: WorkerLease | undefined;
    await updateDurableJson<WorkerLease[]>(
      path.join(this.stateRoot, 'worker-leases.json'),
      (leases) => {
        leases ||= [];
        for (const l of leases)
          if (l.status === 'active' && Date.parse(l.expiresAt) <= this.now()) l.status = 'stale';
        const worker = workers.find(
          (w) =>
            w.status === 'ready' &&
            w.cpu >= req.cpu &&
            w.ramMb >= req.ramMb &&
            (!req.isolated || w.isolated) &&
            w.runtimes.includes(req.runtime) &&
            req.commands.every((c) => w.commands.includes(c)) &&
            !leases.some((l) => l.workerId === w.id && l.status !== 'released')
        );
        if (!worker) throw new Error('WORKER_CAPACITY_UNAVAILABLE');
        acquired = {
          id: crypto.randomUUID(),
          workerId: worker.id,
          owner: this.owner,
          expiresAt: new Date(this.now() + req.timeLimitMs).toISOString(),
          status: 'active',
        };
        return [...leases, acquired];
      }
    );
    return acquired!;
  }
  async releaseWorker(id: string) {
    await updateDurableJson<WorkerLease[]>(
      path.join(this.stateRoot, 'worker-leases.json'),
      (leases) => {
        const found = leases?.find((l) => l.id === id);
        if (!found || found.owner !== this.owner) throw new Error('WORKER_LEASE_NOT_OWNED');
        found.status = 'released';
        return leases!;
      }
    );
  }
}
export class MockInfrastructureProvider extends StaticInfrastructureProvider {}
/** Foreman API v2 GET-only adapter. Capabilities come from operator-approved inventory, never discovered host text. */
export class ForemanInfrastructureProvider extends StaticInfrastructureProvider {
  private endpoint: URL;
  constructor(
    inventory: WorkerInfo[],
    stateRoot: string,
    owner: string,
    url: string,
    private token: string,
    private enabled = false,
    private request: typeof fetch = fetch,
    private username = 'automaker'
  ) {
    super(inventory, stateRoot, owner);
    this.endpoint = new URL(url);
    if (
      this.endpoint.protocol !== 'https:' ||
      this.endpoint.username ||
      this.endpoint.password ||
      this.endpoint.search ||
      this.endpoint.hash ||
      !token
    )
      throw new Error('FOREMAN_CONFIGURATION_INVALID');
  }
  override async listWorkers() {
    if (!this.enabled) return [];
    const out: WorkerInfo[] = [];
    for (const configured of this.inventory.slice(0, 20)) {
      if (!/^\d+$/.test(configured.id)) throw new Error('FOREMAN_HOST_NOT_ALLOWLISTED');
      try {
        const url = new URL(`/api/hosts/${configured.id}`, this.endpoint);
        const response = await this.request(url, {
          method: 'GET',
          headers: {
            Authorization: `Basic ${Buffer.from(`${this.username}:${this.token}`).toString('base64')}`,
            Accept: 'application/json;version=2',
          },
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
        });
        // Read a bounded body; never persist raw host inventory or credentials.
        if (!response.ok) throw new Error('FOREMAN_UNAVAILABLE');
        const reader = response.body?.getReader();
        if (!reader) throw new Error('FOREMAN_UNAVAILABLE');
        let bytes = 0;
        const chunks: Uint8Array[] = [];
        try {
          for (;;) {
            const r = await reader.read();
            if (r.done) break;
            bytes += r.value.byteLength;
            if (bytes > 65536) throw new Error('FOREMAN_RESPONSE_TOO_LARGE');
            chunks.push(r.value);
          }
        } finally {
          await reader.cancel();
        }
        const host = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        out.push({
          ...configured,
          status: String(host.id) === configured.id ? 'ready' : 'unavailable',
        });
      } catch {
        out.push({ ...configured, status: 'unavailable' });
      }
    }
    return out;
  }
}

/** Associates a single externally isolated evaluation with an infrastructure claim. */
export class LeasedExperimentEvaluator {
  constructor(
    private provider: InfrastructureProvider,
    private requirements: WorkerRequirements,
    private remote: {
      evaluate(
        job: import('./engineering-experiments.js').ParametersForExperimentWorker
      ): Promise<import('./engineering-experiments.js').ExperimentMeasurement>;
    }
  ) {}
  async evaluate(job: import('./engineering-experiments.js').ParametersForExperimentWorker) {
    const lease = await this.provider.acquireWorker(this.requirements);
    // A transport error has unknown remote outcome: retain the claim until the operator
    // confirms the worker stopped. Successful complete results permit release.
    const result = await this.remote.evaluate({
      ...job,
      worker: { id: lease.workerId, leaseId: lease.id, expiresAt: lease.expiresAt },
    });
    await this.provider.releaseWorker(lease.id);
    return result;
  }
}

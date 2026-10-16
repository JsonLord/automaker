import crypto from 'crypto';
import path from 'path';
import { sanitizeOpenCodeOutput } from '../../lib/opencode-errors.js';
import { updateDurableJson, readDurableJson } from './durable-store.js';

export type VerificationVerdict = 'VERIFIED' | 'FAILED' | 'NOT_PROVEN' | 'UNAVAILABLE' | 'ERROR';
export interface VerificationRequest {
  taskId: string;
  repository: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
}
export interface VerificationEvidence extends VerificationRequest {
  verifier: 'loki';
  verdict: VerificationVerdict;
  runId: string;
  observedHeadSha: string | null;
  findings: Array<{ message: string; actionable: boolean }>;
  proven: string[];
  notProven: string[];
  artifacts: string[];
  attempts: number;
  startedAt: string;
  finishedAt: string;
}
export interface ArgusExternalVerifier {
  readonly enabled: boolean;
  readonly requiredForMerge: boolean;
  readonly maxRepairAttempts: number;
  verify(input: VerificationRequest): Promise<VerificationEvidence>;
}
export interface IsolatedVerifierExecution {
  isolation: 'external-sandbox';
  execute(
    input: VerificationRequest & {
      runId: string;
      command: 'loki';
      args: string[];
      timeoutMs: number;
    }
  ): Promise<{
    runId: string;
    sandboxVerified: boolean;
    exitCode: number;
    result: unknown;
    artifacts?: string[];
  }>;
}
export interface LokiPolicy {
  enabled: boolean;
  requiredForMerge: boolean;
  maxRepairAttempts: number;
  timeoutMs: number;
  verifyPr?: boolean;
}
export function lokiPolicy(env: NodeJS.ProcessEnv = process.env): LokiPolicy {
  const limit = Number(env.ARGUS_LOKI_MAX_REPAIR_ATTEMPTS || 2);
  return {
    enabled: env.ARGUS_LOKI_ENABLED === 'true',
    requiredForMerge: env.ARGUS_LOKI_REQUIRED_FOR_MERGE === 'true',
    maxRepairAttempts: Number.isInteger(limit) ? Math.max(0, Math.min(limit, 2)) : 2,
    timeoutMs: 120000,
    verifyPr: env.ARGUS_LOKI_VERIFY_PR !== 'false',
  };
}

/** No process execution in the control plane: only a separately authenticated isolated worker. */
export class RemoteLokiExecutor implements IsolatedVerifierExecution {
  readonly isolation = 'external-sandbox' as const;
  constructor(
    private url: string,
    private token: string,
    private transport: typeof fetch = fetch
  ) {
    const target = new URL(url);
    if (
      target.protocol !== 'https:' ||
      target.username ||
      target.password ||
      target.search ||
      target.hash
    )
      throw new Error('LOKI_WORKER_TLS_REQUIRED');
  }
  async execute(
    input: VerificationRequest & {
      runId: string;
      command: 'loki';
      args: string[];
      timeoutMs: number;
    }
  ) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const response = await this.transport(this.url, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`LOKI_WORKER_HTTP_${response.status}`);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('LOKI_WORKER_EMPTY_RESPONSE');
      let size = 0;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65536) {
          await reader.cancel();
          throw new Error('LOKI_EVIDENCE_TOO_LARGE');
        }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally {
      clearTimeout(timer);
    }
  }
}

export class LokiVerifier implements ArgusExternalVerifier {
  readonly enabled: boolean;
  readonly requiredForMerge: boolean;
  readonly maxRepairAttempts: number;
  constructor(
    private executor: IsolatedVerifierExecution | undefined,
    private policy = lokiPolicy(),
    private now = () => Date.now()
  ) {
    this.enabled = policy.enabled;
    this.requiredForMerge = policy.requiredForMerge;
    this.maxRepairAttempts = policy.maxRepairAttempts;
  }
  async verify(input: VerificationRequest): Promise<VerificationEvidence> {
    const runId = crypto.randomUUID();
    const stamp = new Date(this.now()).toISOString();
    const evidence: VerificationEvidence = {
      ...input,
      verifier: 'loki',
      runId,
      verdict: 'UNAVAILABLE',
      observedHeadSha: null,
      findings: [],
      proven: [],
      notProven: [],
      artifacts: [],
      attempts: 1,
      startedAt: stamp,
      finishedAt: stamp,
    };
    if (!this.enabled || this.policy.verifyPr === false) {
      evidence.notProven = ['Loki is disabled'];
      return evidence;
    }
    if (!this.executor || this.executor.isolation !== 'external-sandbox') {
      evidence.notProven = [
        'An isolated external verification worker is required; control-plane PR execution is forbidden',
      ];
      return evidence;
    }
    if (
      !/^[\w.-]+\/[\w.-]+$/.test(input.repository) ||
      !Number.isSafeInteger(input.prNumber) ||
      input.prNumber < 1 ||
      !/^[a-f0-9]{40}$/i.test(input.headSha) ||
      !/^[a-f0-9]{40}$/i.test(input.baseSha)
    )
      throw new Error('LOKI_INVALID_PR_IDENTITY');
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const completed = await Promise.race([
        this.executor.execute({
          ...input,
          runId,
          command: 'loki',
          args: [
            'verify-pr',
            `https://github.com/${input.repository}/pull/${input.prNumber}`,
            '--out',
            `loki-${runId}`,
          ],
          timeoutMs: this.policy.timeoutMs,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('LOKI_VERIFIER_TIMEOUT')),
            this.policy.timeoutMs
          );
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (completed.runId !== runId || completed.sandboxVerified !== true) {
        evidence.notProven = ['Current invocation or sandbox isolation not proven'];
        return evidence;
      }
      const raw = completed.result as Record<string, any>;
      evidence.observedHeadSha = typeof raw?.head === 'string' ? raw.head : null;
      if (
        raw?.head !== input.headSha ||
        raw?.base !== input.baseSha ||
        raw?.pr?.repo?.toLowerCase() !== input.repository.toLowerCase() ||
        raw?.pr?.number !== input.prNumber
      ) {
        evidence.verdict = 'NOT_PROVEN';
        evidence.notProven = [
          'Verifier result does not match the authoritative repository, PR, head and base',
        ];
        return evidence;
      }
      const reasons = (Array.isArray(raw.reasons) ? raw.reasons : [])
        .slice(0, 20)
        .map((reason: unknown) => sanitizeOpenCodeOutput(String(reason)).slice(0, 2000));
      evidence.findings = reasons.map((message: string) => ({
        message,
        actionable: /check still fails on head|package suite did not pass/i.test(message),
      }));
      const checks = (Array.isArray(raw.checks) ? raw.checks : [])
        .slice(0, 20)
        .map((check: unknown) => sanitizeOpenCodeOutput(String(check)).slice(0, 1000));
      if (raw.blocked) {
        evidence.verdict = 'UNAVAILABLE';
        evidence.notProven = reasons.length ? reasons : ['Sandbox unavailable'];
      } else if (raw.verdict === 'VERIFIED' && completed.exitCode === 0 && checks.length) {
        evidence.verdict = 'VERIFIED';
        evidence.proven = checks;
        evidence.notProven = (raw.notes || [])
          .slice(0, 20)
          .map((v: unknown) => sanitizeOpenCodeOutput(String(v)));
      } else {
        evidence.verdict = evidence.findings.some((f) => f.actionable) ? 'FAILED' : 'NOT_PROVEN';
        evidence.notProven = reasons.length ? reasons : ['No discriminating check was proven'];
      }
      evidence.artifacts = (completed.artifacts || [])
        .filter(
          (ref) =>
            /^[a-z0-9][\w./:-]{0,200}$/i.test(ref) && !ref.includes('://') && !ref.includes('..')
        )
        .slice(0, 10);
    } catch (error) {
      evidence.verdict = 'ERROR';
      evidence.notProven = [
        sanitizeOpenCodeOutput(error instanceof Error ? error.message : String(error)),
      ];
    } finally {
      evidence.finishedAt = new Date(this.now()).toISOString();
    }
    return evidence;
  }
}

export class VerificationEvidenceStore {
  file(projectPath: string, taskId: string, headSha: string) {
    return path.join(
      projectPath,
      '.automaker',
      'verification',
      crypto.createHash('sha256').update(taskId).digest('hex'),
      `${headSha}.json`
    );
  }
  async save(projectPath: string, evidence: VerificationEvidence) {
    if (!/^[a-f0-9]{40}$/i.test(evidence.headSha)) throw new Error('LOKI_INVALID_HEAD');
    return updateDurableJson<VerificationEvidence>(
      this.file(projectPath, evidence.taskId, evidence.headSha),
      (current) => ({ ...evidence, attempts: (current?.attempts || 0) + 1 })
    );
  }
  read(projectPath: string, taskId: string, headSha: string) {
    return readDurableJson<VerificationEvidence>(this.file(projectPath, taskId, headSha));
  }
}

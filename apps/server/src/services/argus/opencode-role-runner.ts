import { openCodeFailure, redactOpenCodeOutput } from '../../lib/opencode-errors.js';
import { upsertCompatibleProvider } from './opencode-config.js';
import { resolveOpenCodeModel } from '@automaker/model-resolver';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawnProcess } from '@automaker/platform';
import type { SeniorDiagnosis, SeniorReview } from './types.js';

export interface RoleInvocation {
  role: 'diagnostic' | 'reviewer' | 'engineer';
  contextId: string;
  model: string;
  prompt: string;
  cwd: string;
  readOnly: boolean;
  signal?: AbortSignal;
  isolationDirectory?: string;
  timeoutMs?: number;
}
export type RoleInvoker = (input: RoleInvocation) => Promise<string>;

// The installed OpenCode CLI contract available to production does not expose a
// stable per-run tool-deny flag. Read-only roles therefore receive no repository
// checkout: only bounded supplied evidence in a chmod-read-only temporary cwd.
export const READ_ONLY_ENFORCEMENT =
  'repository-isolation + deny-all-tools + readonly-temp-cwd + bounded-review-input' as const;

export class OpenCodeRoleRunner {
  constructor(
    private readonly model = process.env.COMPATIBLE_URL && process.env.COMPATIBLE_MODEL
      ? resolveOpenCodeModel(process.env.COMPATIBLE_MODEL, 'automaker-compatible').id
      : 'opencode/big-pickle',
    private readonly invoke: RoleInvoker = OpenCodeRoleRunner.invokeCli
  ) {}

  get canExecuteIsolated() {
    return this.invoke !== OpenCodeRoleRunner.invokeCli;
  }

  static async invokeCli(input: RoleInvocation) {
    if (!input.readOnly) throw new Error('SENIOR_ISOLATED_EXECUTOR_UNAVAILABLE');
    const abortController = new AbortController();
    const timer = setTimeout(
      () => abortController.abort(),
      Math.min(input.timeoutMs || 180000, 180000)
    );
    const abort = () => abortController.abort();
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    let result;
    try {
      result = await spawnProcess({
        command: 'opencode',
        args: [
          'run',
          ...(input.isolationDirectory ? ['--pure', '--title', 'Argus inference probe'] : []),
          '--model',
          input.model,
          '--format',
          'json',
        ],
        stdinData: input.prompt,
        maxOutputBytes: 65536,
        inheritEnv: false,
        abortController,
        cwd: input.cwd,
        env: Object.fromEntries(
          [
            ...[
              'PATH',
              'SystemRoot',
              'WINDIR',
              'ComSpec',
              'PATHEXT',
              'TEMP',
              'TMP',
              'HTTPS_PROXY',
              'HTTP_PROXY',
              'ALL_PROXY',
              'NO_PROXY',
              'https_proxy',
              'http_proxy',
              'all_proxy',
              'no_proxy',
              'NODE_EXTRA_CA_CERTS',
              'SSL_CERT_FILE',
              'OPENCODE_CONFIG',
              'XDG_CONFIG_HOME',
              'XDG_DATA_HOME',
            ].map((name) => [name, process.env[name]]),
            ['OPENCODE_PERMISSION', JSON.stringify({ '*': 'deny' })],
            ['OPENCODE_DISABLE_PROJECT_CONFIG', 'true'],
            ['HOME', process.env.HOME],
            ['COMPATIBLE_API_KEY', process.env.COMPATIBLE_API_KEY],
            ...(input.isolationDirectory
              ? [
                  ['HOME', input.isolationDirectory],
                  ['XDG_CONFIG_HOME', path.join(input.isolationDirectory, 'config')],
                  ['XDG_DATA_HOME', path.join(input.isolationDirectory, 'data')],
                  ['XDG_CACHE_HOME', path.join(input.isolationDirectory, 'cache')],
                  ['XDG_STATE_HOME', path.join(input.isolationDirectory, 'state')],
                  ['TMPDIR', input.isolationDirectory],
                  ['OPENCODE_CONFIG', path.join(input.isolationDirectory, 'opencode.json')],
                  ['OPENCODE_DISABLE_AUTOUPDATE', 'true'],
                  ['OPENCODE_DISABLE_MODELS_FETCH', 'true'],
                  ['OPENCODE_DISABLE_LSP_DOWNLOAD', 'true'],
                  ['OPENCODE_DISABLE_EXTERNAL_SKILLS', 'true'],
                ]
              : []),
          ].filter((entry): entry is [string, string] => Boolean(entry[1]))
        ),
      });
    } catch {
      throw new Error(
        openCodeFailure(
          'OpenCode role subprocess failed or timed out',
          resolveOpenCodeModel(input.model)
        )
      );
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
    }
    if (result.exitCode !== 0)
      throw new Error(
        openCodeFailure(
          result.stderr || result.stdout,
          resolveOpenCodeModel(input.model),
          result.exitCode
        )
      );
    const text: string[] = [];
    let sessionId: string | undefined;
    for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      sessionId = event.sessionID || sessionId;
      if (event.type === 'tool_use' || event.type === 'tool' || event.part?.type === 'tool')
        throw new Error('OPENCODE_UNEXPECTED_TOOL_EVENT');
      if (
        event.type === 'error' ||
        (event.type === 'step_finish' && event.part?.reason === 'error')
      ) {
        throw new Error(
          openCodeFailure(
            typeof event.error === 'string'
              ? event.error
              : event.error?.data?.message ||
                  event.error?.message ||
                  event.error?.name ||
                  'Unknown error',
            resolveOpenCodeModel(input.model),
            result.exitCode,
            sessionId
          )
        );
      }
      if (event.type === 'text' && typeof event.part?.text === 'string') text.push(event.part.text);
    }
    if (!text.length)
      throw new Error(
        openCodeFailure(
          result.stderr || 'OpenCode returned no text content',
          resolveOpenCodeModel(input.model),
          result.exitCode,
          sessionId
        )
      );
    return redactOpenCodeOutput(text.join(''));
  }

  /** Bounded text-only diagnostic, with no checkout or inherited user configuration. */
  static async probe(model: string) {
    const identity = resolveOpenCodeModel(model);
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-diag-'));
    try {
      let config: Record<string, unknown> = {
        permission: { '*': 'deny' },
        plugin: [],
        instructions: [],
      };
      if (identity.provider === 'automaker-compatible') {
        if (!process.env.COMPATIBLE_URL || !process.env.COMPATIBLE_API_KEY)
          throw new Error('OPENCODE_MODEL_NOT_CONFIGURED');
        config = upsertCompatibleProvider(config, process.env.COMPATIBLE_URL, identity.model);
      }
      await fs.writeFile(path.join(sandbox, 'opencode.json'), JSON.stringify(config), {
        mode: 0o600,
      });
      const cwd = path.join(sandbox, 'empty');
      await fs.mkdir(cwd, { mode: 0o555 });
      const text = await OpenCodeRoleRunner.invokeCli({
        role: 'diagnostic',
        contextId: crypto.randomUUID(),
        model: identity.id,
        prompt: 'Reply with exactly LOCAL_PROBE_OK. Do not use any tools.',
        cwd,
        readOnly: true,
        isolationDirectory: sandbox,
        timeoutMs: 45000,
      });
      if (text.trim() !== 'LOCAL_PROBE_OK') throw new Error('OPENCODE_UNEXPECTED_PROBE_TEXT');
      return { model: identity.id, result: 'LOCAL_PROBE_OK' };
    } finally {
      await fs.chmod(path.join(sandbox, 'empty'), 0o755).catch(() => {});
      await fs.rm(sandbox, { recursive: true, force: true });
    }
  }

  async analyzePaper(payload: unknown, signal?: AbortSignal) {
    return this.readOnly(
      'diagnostic',
      payload,
      (value: unknown) => {
        const result = value as {
          algorithms?: unknown;
          equations?: unknown;
          missingDetails?: unknown;
          implementationSteps?: unknown;
        };
        const boundedStrings = (item: unknown): item is string[] =>
          Array.isArray(item) &&
          item.length <= 20 &&
          item.every((s) => typeof s === 'string' && s.length <= 4000);
        if (
          !result ||
          !boundedStrings(result.algorithms) ||
          !boundedStrings(result.equations) ||
          !boundedStrings(result.missingDetails) ||
          !boundedStrings(result.implementationSteps)
        )
          throw new Error('OPENCODE_MALFORMED_PAPER_ANALYSIS');
        return {
          algorithms: result.algorithms,
          equations: result.equations,
          missingDetails: result.missingDetails,
          implementationSteps: result.implementationSteps,
        };
      },
      signal
    );
  }

  async judge(payload: unknown, signal?: AbortSignal) {
    return this.readOnly(
      'reviewer',
      payload,
      (value: unknown) => {
        const result = value as { score?: unknown; reason?: unknown };
        if (
          !result ||
          typeof result.score !== 'number' ||
          !Number.isFinite(result.score) ||
          result.score < 0 ||
          result.score > 1 ||
          typeof result.reason !== 'string' ||
          result.reason.length > 4000
        )
          throw new Error('OPENCODE_MALFORMED_JUDGE');
        return { score: result.score, reason: result.reason };
      },
      signal
    );
  }

  async diagnose(payload: unknown): Promise<{ contextId: string; result: SeniorDiagnosis }> {
    return this.readOnly('diagnostic', payload, validateDiagnosis);
  }

  async review(payload: unknown): Promise<{ contextId: string; result: SeniorReview }> {
    return this.readOnly('reviewer', payload, validateReview);
  }

  async execute(prompt: string, worktreePath: string) {
    const contextId = crypto.randomUUID();
    const output = await this.invoke({
      role: 'engineer',
      contextId,
      model: resolveOpenCodeModel(this.model).id,
      prompt,
      cwd: worktreePath,
      readOnly: false,
    });
    return { contextId, output };
  }

  private async readOnly<T>(
    role: 'diagnostic' | 'reviewer',
    payload: unknown,
    validate: (value: unknown) => T,
    signal?: AbortSignal
  ) {
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), `automaker-${role}-`));
    await fs.chmod(sandbox, 0o555);
    const contextId = crypto.randomUUID();
    try {
      const output = await this.invoke({
        role,
        contextId,
        model: resolveOpenCodeModel(this.model).id,
        prompt: `${JSON.stringify(payload)}\nReturn only the required JSON object.`,
        cwd: sandbox,
        readOnly: true,
        signal,
      });
      return { contextId, result: validate(JSON.parse(extractJson(output))) };
    } finally {
      await fs.chmod(sandbox, 0o755);
      await fs.rm(sandbox, { recursive: true, force: true });
    }
  }
}

function extractJson(value: string) {
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('OPENCODE_MALFORMED_OUTPUT');
  return value.slice(start, end + 1);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
function validateDiagnosis(value: any): SeniorDiagnosis {
  if (
    !value ||
    typeof value.rootCause !== 'string' ||
    typeof value.recommendedFix !== 'string' ||
    typeof value.juniorCanRepair !== 'boolean' ||
    !strings(value.evidence) ||
    !strings(value.filesLikelyAffected)
  )
    throw new Error('OPENCODE_MALFORMED_DIAGNOSIS');
  return value;
}
function validateReview(value: any): SeniorReview {
  if (
    !value ||
    !['approve', 'request_changes', 'blocked'].includes(value.verdict) ||
    typeof value.reviewedHeadSha !== 'string' ||
    !Array.isArray(value.findings) ||
    !strings(value.requiredChanges) ||
    !strings(value.evidence)
  )
    throw new Error('OPENCODE_MALFORMED_REVIEW');
  for (const finding of value.findings)
    if (
      !['critical', 'high', 'medium', 'low'].includes(finding.severity) ||
      typeof finding.description !== 'string' ||
      typeof finding.evidence !== 'string' ||
      (finding.file !== undefined && typeof finding.file !== 'string') ||
      (finding.line !== undefined && typeof finding.line !== 'number')
    )
      throw new Error('OPENCODE_MALFORMED_REVIEW');
  return value;
}

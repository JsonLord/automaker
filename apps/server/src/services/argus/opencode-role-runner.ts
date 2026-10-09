import { openCodeFailure, redactOpenCodeOutput } from '../../lib/opencode-errors.js';
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
}
export type RoleInvoker = (input: RoleInvocation) => Promise<string>;

// The installed OpenCode CLI contract available to production does not expose a
// stable per-run tool-deny flag. Read-only roles therefore receive no repository
// checkout: only bounded supplied evidence in a chmod-read-only temporary cwd.
export const READ_ONLY_ENFORCEMENT =
  'repository-isolation + readonly-temp-cwd + bounded-review-input' as const;

export class OpenCodeRoleRunner {
  constructor(
    private readonly model = process.env.COMPATIBLE_URL && process.env.COMPATIBLE_MODEL
      ? resolveOpenCodeModel(process.env.COMPATIBLE_MODEL, 'automaker-compatible').id
      : 'opencode/big-pickle',
    private readonly invoke: RoleInvoker = OpenCodeRoleRunner.invokeCli
  ) {}

  static async invokeCli(input: RoleInvocation) {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), 180000);
    let result;
    try {
      result = await spawnProcess({
        command: 'opencode',
        args: ['run', '--model', input.model, '--format', 'json'],
        stdinData: input.prompt,
        maxOutputBytes: 65536,
        abortController,
        cwd: input.cwd,
        env: Object.fromEntries(
          [
            ['PATH', process.env.PATH],
            ['HOME', process.env.HOME],
            ['COMPATIBLE_API_KEY', process.env.COMPATIBLE_API_KEY],
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
      if (event.type === 'error') {
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
    validate: (value: unknown) => T
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

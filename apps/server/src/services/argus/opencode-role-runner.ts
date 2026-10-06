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

export class OpenCodeRoleRunner {
  constructor(
    private readonly model = `automaker-compatible/${process.env.COMPATIBLE_MODEL || ''}`,
    private readonly invoke: RoleInvoker = OpenCodeRoleRunner.invokeCli
  ) {}

  static async invokeCli(input: RoleInvocation) {
    const result = await spawnProcess({
      command: 'opencode',
      args: ['run', '--model', input.model, '--format', 'json', input.prompt],
      cwd: input.cwd,
      env: Object.fromEntries(
        [
          ['PATH', process.env.PATH],
          ['HOME', process.env.HOME],
          ['COMPATIBLE_API_KEY', process.env.COMPATIBLE_API_KEY],
        ].filter((entry): entry is [string, string] => Boolean(entry[1]))
      ),
    });
    if (result.exitCode !== 0) throw new Error('OPENCODE_ROLE_FAILED');
    return result.stdout;
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
      model: this.model,
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
        model: this.model,
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

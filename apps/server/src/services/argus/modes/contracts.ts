import { z } from 'zod';
import crypto from 'crypto';
import type {
  ArgusModeConfig,
  ArgusModeId,
  ArgusModeInput,
  ArgusModeRun,
  ArgusModeArtifact,
  ArgusModeEvaluation,
  ArgusModeTask,
} from '@automaker/types';
import { redactOpenCodeEvent } from '../../../lib/opencode-errors.js';

const text = z.string().min(1).max(16000);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const modeIdSchema = z.enum(['default', 'rea', 'paper2code', 'eval']);
export const modeConfigSchema = z
  .object({
    capabilities: z
      .object({
        repositoryRead: z.boolean(),
        referenceImplementation: z.boolean(),
        llmJudge: z.boolean(),
      })
      .strict(),
    permissions: z.object({ repositoryChanges: z.boolean(), modelCalls: z.boolean() }).strict(),
    evaluation: z
      .object({ minimumScore: z.number().min(0).max(1), requireJudge: z.boolean() })
      .strict(),
  })
  .strict();
export const modeInputSchema = z
  .object({
    question: text,
    authorized: z.boolean().optional(),
    targetKind: z.enum(['web', 'api', 'source', 'native']).optional(),
    sources: z
      .array(
        z
          .object({
            id,
            kind: z.enum(['observation', 'repository']),
            text: text.optional(),
            path: z.string().min(1).max(400).optional(),
          })
          .strict()
      )
      .max(20)
      .optional(),
    hypotheses: z
      .array(
        z.object({ id, sourceId: id, contains: z.string().min(1).max(1000), claim: text }).strict()
      )
      .max(20)
      .optional(),
    paper: z
      .object({
        title: text,
        reference: z.string().max(500).optional(),
        text: text.optional(),
        documentPath: z.string().max(400).optional(),
        algorithm: z.enum(['mean', 'sum', 'linear']).optional(),
        slope: z.number().finite().optional(),
        intercept: z.number().finite().optional(),
        ambiguities: z.array(text).max(20).optional(),
        examples: z
          .array(
            z
              .object({
                id,
                input: z.array(z.number().finite()).max(100),
                expected: z.number().finite(),
              })
              .strict()
          )
          .max(40)
          .optional(),
      })
      .strict()
      .optional(),
    dataset: z
      .object({
        id,
        version: id,
        rubricVersion: id,
        rule: z.enum(['exact', 'contains', 'numeric']),
        tolerance: z.number().min(0).max(100).optional(),
        candidates: z
          .array(
            z
              .object({
                id,
                model: z.string().min(1).max(200),
                commitSha: z.string().regex(/^(?!0{40}$)[0-9a-f]{40}$/i),
                rows: z
                  .array(
                    z
                      .object({
                        id,
                        input: text,
                        expected: z.string().max(16000),
                        actual: z.string().max(16000),
                      })
                      .strict()
                  )
                  .min(1)
                  .max(100),
              })
              .strict()
          )
          .min(1)
          .max(8),
      })
      .strict()
      .optional(),
    useJudge: z.boolean().optional(),
    baselineRunId: id.optional(),
  })
  .strict();
export const defaultConfig = (): ArgusModeConfig => ({
  capabilities: { repositoryRead: false, referenceImplementation: false, llmJudge: false },
  permissions: { repositoryChanges: false, modelCalls: false },
  evaluation: { minimumScore: 1, requireJudge: false },
});
export class ModeError extends Error {
  constructor(
    public code: string,
    public status = 409
  ) {
    super(code);
  }
}
export function invariant(condition: unknown, code: string, status = 409): asserts condition {
  if (!condition) throw new ModeError(code, status);
}
export const digest = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
export function sanitize<T>(value: T): T {
  const clean = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(clean);
    if (input && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input).map(([k, v]) => [
          k,
          /^(api[-_]?key|token|secret|password|authorization|cookie)$/i.test(k)
            ? '[REDACTED]'
            : clean(v),
        ])
      );
    return redactOpenCodeEvent(
      input,
      Object.fromEntries(
        Object.entries(process.env).filter(([name]) => name !== 'AUTOMAKER_HIDE_API_KEY')
      )
    );
  };
  return clean(value) as T;
}
export function artifact(name: string, value: unknown): ArgusModeArtifact {
  const content =
    typeof value === 'string' ? sanitize(value) : JSON.stringify(sanitize(value), null, 2);
  invariant(Buffer.byteLength(content) <= 262144, 'MODE_ARTIFACT_TOO_LARGE');
  const sha256 = digest(content);
  return {
    name,
    content,
    sha256,
    evidenceId: `sha256:${sha256}`,
    mediaType: name.endsWith('.json')
      ? 'application/json'
      : name.endsWith('.mjs')
        ? 'text/javascript'
        : 'text/markdown',
  };
}
export interface ModeResult {
  artifacts: ArgusModeArtifact[];
  tasks: ArgusModeTask[];
  evaluation: ArgusModeEvaluation;
  worktreePath?: string;
}
export interface ModeContext {
  projectPath: string;
  run: ArgusModeRun;
  approval?: { repositoryChanges: true; sourceSha: string };
  signal: AbortSignal;
  baseline?: ArgusModeRun;
}
export interface ArgusModeAdapter {
  id: ArgusModeId;
  validate(config: ArgusModeConfig, input: ArgusModeInput): Promise<string[]>;
  plan(input: ArgusModeInput): string[];
  execute(context: ModeContext): Promise<ModeResult>;
  evaluate(result: ModeResult): ArgusModeEvaluation;
}
export abstract class BaseMode implements ArgusModeAdapter {
  abstract id: ArgusModeId;
  abstract plan(input: ArgusModeInput): string[];
  abstract execute(context: ModeContext): Promise<ModeResult>;
  async validate(_config: ArgusModeConfig, _input: ArgusModeInput): Promise<string[]> {
    return [];
  }
  evaluate(result: ModeResult) {
    return result.evaluation;
  }
}

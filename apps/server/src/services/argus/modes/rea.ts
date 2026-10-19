import type { ArgusModeConfig, ArgusModeInput } from '@automaker/types';
import {
  BaseMode,
  artifact,
  digest,
  sanitize,
  type ModeContext,
  type ModeResult,
} from './contracts.js';
import { readEvidenceFile } from './evidence.js';

/** Lightweight evidence/hypothesis/experiment adapter inspired by the pinned REA workflow.
 * No upstream code or binary-analysis toolchain is bundled. */
export class ReaMode extends BaseMode {
  readonly id = 'rea' as const;
  plan() {
    return [
      'Record authorization and research question',
      'Collect bounded supplied observations/source evidence',
      'Version hypotheses',
      'Execute non-destructive evidence checks',
      'Report verified and unproven claims',
    ];
  }
  async validate(config: ArgusModeConfig, input: ArgusModeInput) {
    return [
      ...(!input.authorized ? ['REA_AUTHORIZATION_REQUIRED'] : []),
      ...(input.targetKind === 'native' ? ['REA_NATIVE_WORKER_UNAVAILABLE'] : []),
      ...(!input.sources?.length ? ['REA_SOURCE_EVIDENCE_REQUIRED'] : []),
      ...(input.sources?.some((s) => s.kind === 'repository') && !config.capabilities.repositoryRead
        ? ['MODE_REPOSITORY_READ_DENIED']
        : []),
    ];
  }
  async execute({ projectPath, run, signal }: ModeContext): Promise<ModeResult> {
    const evidence: Array<{
      id: string;
      version: string;
      origin: string | undefined;
      text: string;
    }> = [];
    for (const source of run.input.sources || []) {
      signal.throwIfAborted();
      const text = sanitize(
        source.kind === 'repository' && source.path
          ? await readEvidenceFile(projectPath, source.path)
          : source.text
      );
      if (!text) continue;
      evidence.push({
        id: source.id,
        version: digest(text),
        origin:
          source.kind === 'repository'
            ? source.path
            : 'user-supplied observation; collection not independently verified',
        text,
      });
    }
    const sourceFacts = evidence.map((source) => {
      const importedModules = [
        ...source.text.matchAll(/(?:from\s+|require\s*\(\s*)['"]([^'"\n]{1,200})['"]/g),
      ]
        .map((match) => match[1])
        .slice(0, 100);
      let dependencyNames: string[] = [];
      let apiPaths: string[] = [];
      try {
        const document = JSON.parse(source.text) as {
          dependencies?: Record<string, unknown>;
          devDependencies?: Record<string, unknown>;
          paths?: Record<string, unknown>;
        };
        dependencyNames = [
          ...new Set([
            ...Object.keys(document.dependencies || {}),
            ...Object.keys(document.devDependencies || {}),
          ]),
        ].slice(0, 100);
        apiPaths = Object.keys(document.paths || {})
          .filter((key) => key.startsWith('/'))
          .slice(0, 100);
      } catch {
        /* Non-JSON evidence remains text evidence, not an invented contract. */
      }
      return {
        sourceId: source.id,
        importedModules,
        dependencyNames,
        apiPaths,
        interpretation: 'Static source/document facts only; live execution is NOT_PROVEN',
      };
    });
    const hypotheses = (run.input.hypotheses || []).map((h) => {
      const source = evidence.find((e) => e.id === h.sourceId);
      return {
        ...h,
        evidenceVersion: source?.version || null,
        result: source
          ? source.text.includes(h.contains)
            ? 'SUPPORTED'
            : 'REFUTED'
          : 'NOT_PROVEN',
        experiment: 'bounded literal containment check; no executable expressions',
      };
    });
    const missing = hypotheses.filter((h) => h.result === 'NOT_PROVEN');
    const tasks = hypotheses
      .filter((h) => h.result === 'SUPPORTED')
      .map((h) => ({
        id: `rea-${digest(h.id).slice(0, 16)}`,
        title: `Investigate verified observation: ${h.claim.slice(0, 100)}`,
        description: `Research question: ${run.input.question}\nEvidence-backed hypothesis: ${h.claim}\nEvidence ${h.sourceId}@${h.evidenceVersion}. A containment check is not proof of causality.`,
        acceptanceCriteria: [
          'Add a behavior-level regression test',
          'Preserve existing API contracts',
        ],
        evidenceIds: [`sha256:${h.evidenceVersion}`],
      }));
    return {
      artifacts: [
        artifact('rea-evidence.json', {
          version: 1,
          question: run.input.question,
          evidence,
          sourceFacts,
        }),
        artifact('rea-hypotheses.json', { version: 1, hypotheses }),
        artifact(
          'rea-reproduction.md',
          `# Reproduction\n\nInput evidence is versioned by SHA-256. Re-run the same literal checks on these bytes. No target mutation, active probing, or native execution occurred.\n\n${hypotheses.map((h) => `- ${h.id}: ${h.result}; ${h.sourceId} contains ${JSON.stringify(h.contains)}`).join('\n')}`
        ),
        artifact(
          'rea-report.md',
          `# Reverse-engineering report\n\n${run.input.question}\n\n${evidence.length} observations; ${hypotheses.length} bounded experiments.\n\n## Static architecture/dependency/contract evidence\n${JSON.stringify(sourceFacts, null, 2)}\n\n${hypotheses.map((h) => `- ${h.claim}: ${h.result}`).join('\n')}\n\nSource observations may be untrusted. Supported text claims do not establish architecture or causality. No live target was contacted. Native binary inspection requires an optional isolated worker.`
        ),
      ],
      tasks,
      evaluation: {
        verdict: evidence.length && !missing.length ? 'PASS' : 'BLOCKED',
        score: null,
        reasons: missing.map((h) => `Missing evidence: ${h.sourceId}`),
        advisory: true,
      },
    };
  }
}

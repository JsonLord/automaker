import crypto from 'crypto';
import path from 'path';
import type { IdeationService } from '../ideation-service.js';
import type { ArgusService, ArgusPlannedTask } from './types.js';
import type { ArgusOrchestrator } from './orchestrator.js';
import { readDurableJson, updateDurableJson } from './durable-store.js';
import { TaskHistoryStore } from './task-history.js';
import { saveArgusState } from './project-lifecycle.js';

export interface ImprovementHypothesis {
  id: string;
  observation: string;
  hypothesis: string;
  sourceEvidence: string[];
  expectedImprovement: string;
  measurement: string;
  baseline: string;
  acceptanceThreshold: string;
  estimatedRisk: 'normal' | 'sensitive';
  proposedTest: {
    fixture: string;
    expectedResult: string;
    failureProof: string;
    commands: string[];
  };
  confidence: number;
  disposition: 'proposed' | 'admitted' | 'rejected' | 'human-approval' | 'completed';
  ideaId?: string;
}
interface DiscoveryState {
  status: 'IMPROVEMENT_DISCOVERY' | 'QUIESCENT' | 'NO_ACTION';
  hypotheses: ImprovementHypothesis[];
  admitted: number;
  iterations: number;
  reason: string;
}
/** Evidence proposal and admission, invoked only by the authoritative runner. */
export class EngineeringScout {
  constructor(
    private argus: ArgusService,
    private planner: ArgusOrchestrator,
    private ideas: Pick<IdeationService, 'createIdea'>,
    private enabled = process.env.ARGUS_CONTINUOUS_ENGINEERING_ENABLED === 'true',
    private history = new TaskHistoryStore(),
    private limits = { hypotheses: 5, admitted: 3, iterations: 5 }
  ) {}
  private file(root: string) {
    return path.join(root, '.automaker', 'discovery.json');
  }
  async status(root: string) {
    return readDurableJson<DiscoveryState>(this.file(root));
  }
  async discover(root: string): Promise<boolean> {
    const state = await this.argus.getStatus(root);
    if (!this.enabled || !state || state.autonomy !== 'satisfied' || state.activeTask) return false;
    let record = (await this.status(root)) || {
      status: 'IMPROVEMENT_DISCOVERY' as const,
      hypotheses: [],
      admitted: 0,
      iterations: 0,
      reason: '',
    };
    if (
      record.status === 'QUIESCENT' ||
      record.iterations >= this.limits.iterations ||
      record.admitted >= this.limits.admitted
    )
      return false;
    record.iterations++;
    const outcomes = await this.history.list(root);
    const gaps = outcomes.flatMap((t) =>
      (t.loki?.notProven || []).map((gap) => ({ gap, task: t.taskId, sha: t.headSha }))
    );
    for (const gap of gaps.slice(0, 20)) {
      const id = crypto
        .createHash('sha256')
        .update(`${gap.task}:${gap.sha}:${gap.gap}`)
        .digest('hex')
        .slice(0, 24);
      if (
        record.hypotheses.some((h) => h.id === id) ||
        record.hypotheses.length >= this.limits.hypotheses
      )
        continue;
      const observation = gap.gap.slice(0, 1000);
      const sensitive = /auth|billing|secret|deploy|migration|permission|credential|payment/i.test(
        observation
      );
      record.hypotheses.push({
        id,
        observation,
        hypothesis: 'A discriminating regression test can close this observed verification gap.',
        sourceEvidence: [`task:${gap.task}`, `head:${gap.sha}`, `loki-not-proven:${observation}`],
        expectedImprovement: 'Replace unproven behavior with reproducible test evidence',
        measurement:
          'Deterministic regression assertion fails on a fault-injected fixture and passes on the corrected behavior',
        baseline: 'Loki reports this behavior NOT_PROVEN',
        acceptanceThreshold:
          'Demonstrate both failing and passing controls with no network or production credentials',
        estimatedRisk: sensitive ? 'sensitive' : 'normal',
        proposedTest: {
          fixture: `Reproduce the observed gap: ${observation}`,
          expectedResult: 'Assertion distinguishes correct behavior from the injected failure',
          failureProof: 'Run a negative control; retain its failing output',
          commands: ['npm run test:server'],
        },
        confidence: 0.7,
        disposition: sensitive ? 'human-approval' : 'proposed',
      });
    }
    await updateDurableJson(this.file(root), () => record);
    for (const proposal of record.hypotheses.filter((h) => h.disposition === 'proposed')) {
      // Persist intent before creating an optional board idea; an uncertain write never executes work.
      if (!proposal.ideaId) {
        proposal.ideaId = 'pending';
        await updateDurableJson(this.file(root), () => record);
        const idea = await this.ideas.createIdea(root, {
          title: `Regression evidence: ${proposal.observation.slice(0, 100)}`,
          description: JSON.stringify(proposal),
          category: 'technical',
          status: 'raw',
        });
        proposal.ideaId = idea.id;
        await updateDurableJson(this.file(root), () => record);
      }
      const context = {
        improvementHypothesis: proposal,
        budgets: { remainingAdmissions: this.limits.admitted - record.admitted },
        completedTasks: outcomes.map((t) => t.taskId),
      };
      const decision = await this.argus.managerHandoff(root, context);
      if (
        !decision.admitted ||
        !decision.evidence?.length ||
        decision.recommendedExecutor === 'blocked'
      ) {
        proposal.disposition = 'rejected';
        continue;
      }
      const planned = await this.argus.plannerNextTask(root, decision, context);
      if (!planned) {
        proposal.disposition = 'rejected';
        continue;
      }
      // Keep the admitted test brief authoritative even when Planner wording drifts.
      const task: ArgusPlannedTask = {
        ...planned,
        taskId: `improvement-${proposal.id}`,
        title: `Test: ${proposal.observation.slice(0, 120)}`,
        description: `${proposal.hypothesis}\n${JSON.stringify(proposal.proposedTest)}\nEvidence: ${proposal.sourceEvidence.join('\n')}`,
        acceptanceCriteria: [proposal.acceptanceThreshold],
        evidenceRequired: [proposal.measurement, proposal.proposedTest.failureProof],
        recommendedExecutor: 'junior',
        risk: 'normal',
      };
      await this.planner.admitPlannedTask(root, task, true);
      proposal.disposition = 'admitted';
      record.admitted++;
      record.reason = 'MANAGER_ADMITTED_TEST';
      await updateDurableJson(this.file(root), () => record);
      return true;
    }
    record.status = 'QUIESCENT';
    record.reason = record.hypotheses.length ? 'NO_ADMISSIBLE_WORK' : 'NO_ACTION';
    await updateDurableJson(this.file(root), () => record);
    state.latestStatus = 'QUIESCENT';
    await saveArgusState(root, state);
    return false;
  }
}

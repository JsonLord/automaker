import type { ArgusModeConfig } from '@automaker/types';
import { BaseMode, artifact, type ModeContext, type ModeResult } from './contracts.js';
import type { ArgusService } from '../types.js';
export class DefaultMode extends BaseMode {
  readonly id = 'default' as const;
  constructor(private argus: ArgusService) {
    super();
  }
  async validate(config: ArgusModeConfig) {
    return config.permissions.modelCalls ? [] : ['MODE_MODEL_CALLS_DENIED'];
  }
  plan() {
    return [
      'Use existing Argus Manager admission',
      'Use existing Planner task contract',
      'Await explicit task approval',
      'Engineer/Jules → PR → CI → Review → human merge gate',
    ];
  }
  async execute({ projectPath, run, signal }: ModeContext): Promise<ModeResult> {
    const state = await this.argus.getStatus(projectPath);
    if (!state)
      return {
        tasks: [],
        artifacts: [
          artifact(
            'default-report.md',
            '# Default mode\n\nBLOCKED: register this project with existing Argus setup first.'
          ),
        ],
        evaluation: {
          verdict: 'BLOCKED',
          score: null,
          reasons: ['ARGUS_PROJECT_NOT_REGISTERED'],
          advisory: false,
        },
      };
    const decision = await this.argus.managerHandoff(projectPath, {
      mode: 'default',
      modeRunId: run.id,
      question: run.input.question,
    });
    signal.throwIfAborted();
    const task = decision.admitted
      ? await this.argus.plannerNextTask(projectPath, decision, {
          mode: 'default',
          modeRunId: run.id,
        })
      : null;
    return {
      tasks: task
        ? [
            {
              id: task.taskId,
              title: task.title,
              description: task.description,
              acceptanceCriteria: task.acceptanceCriteria,
              evidenceIds: task.evidenceRequired,
            },
          ]
        : [],
      artifacts: [
        artifact('default-plan.json', { decision, task }),
        artifact(
          'default-report.md',
          `# Default workflow\n\nManager: ${decision.reason}\n\n${task ? `Planner task ${task.taskId} is proposed; explicit approval is required before admission to the existing executor workflow.` : 'No task admitted.'}\n\nMode selection and this planning run do not start a campaign or change autonomy.`
        ),
      ],
      evaluation: {
        verdict: task ? 'PASS' : 'BLOCKED',
        score: null,
        reasons: task ? [] : [decision.reason],
        advisory: true,
      },
    };
  }
}

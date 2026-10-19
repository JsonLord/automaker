import { useEffect, useState } from 'react';
import type {
  ArgusModeConfig,
  ArgusModeDescriptor,
  ArgusModeId,
  ArgusModeInput,
  ArgusModeRun,
  ArgusModeState,
} from '@automaker/types';
import { getHttpApiClient } from '@/lib/http-api-client';
import { Button } from '@/components/ui/button';

const examples: Record<ArgusModeId, ArgusModeInput> = {
  default: { question: 'Plan the next engineering task for this project' },
  rea: {
    question: 'Does the supplied API observation include a health endpoint?',
    targetKind: 'api',
    authorized: false,
    sources: [{ id: 'api-observation', kind: 'observation', text: 'GET /health returns 200' }],
    hypotheses: [
      {
        id: 'health',
        sourceId: 'api-observation',
        contains: '200',
        claim: 'The supplied observation reports HTTP 200',
      },
    ],
  },
  paper2code: {
    question: 'Reproduce the supplied arithmetic mean specification',
    paper: {
      title: 'Synthetic arithmetic mean specification',
      text: 'For a nonempty vector of real numbers, return their sum divided by the vector length.',
      algorithm: 'mean',
      examples: [{ id: 'mean-fixture', input: [2, 4, 6], expected: 4 }],
      ambiguities: [],
    },
  },
  eval: {
    question: 'Compare versioned golden answers',
    dataset: {
      id: 'golden',
      version: 'v1',
      rubricVersion: 'exact-v1',
      rule: 'exact',
      candidates: [
        {
          id: 'candidate',
          model: 'supplied-output',
          commitSha: 'REPLACE_WITH_CURRENT_40_CHARACTER_SHA',
          rows: [{ id: 'health', input: 'health state', expected: 'ok', actual: 'ok' }],
        },
      ],
    },
  },
};
export function ArgusModePanel({ projectPath }: { projectPath: string }) {
  const [state, setState] = useState<ArgusModeState | null>(null);
  const [descriptors, setDescriptors] = useState<ArgusModeDescriptor[]>([]);
  const [config, setConfig] = useState<ArgusModeConfig | null>(null);
  const [input, setInput] = useState('');
  const [run, setRun] = useState<ArgusModeRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [approve, setApprove] = useState(false);
  const client = getHttpApiClient().argusModes;
  useEffect(() => {
    let active = true;
    Promise.all([client.state(projectPath), client.list(projectPath)])
      .then(([value, list]) => {
        if (!active) return;
        setState(value);
        setDescriptors(list.modes);
        setConfig(value.configs[value.activeMode]);
        setInput(JSON.stringify(examples[value.activeMode], null, 2));
        setRun(value.runs.at(-1) || null);
      })
      .catch(() => {
        if (active) setError('Argus modes are unavailable.');
      });
    return () => {
      active = false;
    };
  }, [projectPath, client]);
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Mode operation failed');
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    const value = await client.state(projectPath);
    setState(value);
    return value;
  };
  if (!state || !config)
    return error ? (
      <p role="alert" className="px-4 py-2 text-xs">
        {error}
      </p>
    ) : null;
  const description = descriptors.find((d) => d.id === state.activeMode)?.description;
  const updateConfig = (section: 'capabilities' | 'permissions', key: string, value: boolean) =>
    setConfig({ ...config, [section]: { ...config[section], [key]: value } });
  return (
    <section aria-label="Argus modes" className="border-b px-4 py-2 text-xs space-y-2">
      <div className="flex flex-wrap gap-2 items-center">
        <strong>Argus mode</strong>
        <select
          aria-label="Argus operating mode"
          className="rounded border bg-background p-1"
          value={state.activeMode}
          disabled={busy}
          onChange={(e) =>
            void perform(async () => {
              const value = await client.select(
                projectPath,
                e.target.value as ArgusModeId,
                state.revision
              );
              setState(value);
              setConfig(value.configs[value.activeMode]);
              setInput(JSON.stringify(examples[value.activeMode], null, 2));
              setRun(null);
              setApprove(false);
            })
          }
        >
          {descriptors.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
        <span>{description}</span>
      </div>
      <p>Mode selection does not start a campaign. Plan first, then run explicitly.</p>
      <details>
        <summary>
          {descriptors.find((d) => d.id === state.activeMode)?.label} configuration and permissions
        </summary>
        <div className="flex flex-wrap gap-3 py-2">
          <label>
            <input
              type="checkbox"
              checked={config.capabilities.repositoryRead}
              onChange={(e) => updateConfig('capabilities', 'repositoryRead', e.target.checked)}
            />{' '}
            Read explicitly selected project files
          </label>
          {state.activeMode === 'paper2code' && (
            <label>
              <input
                type="checkbox"
                checked={config.capabilities.referenceImplementation}
                onChange={(e) =>
                  updateConfig('capabilities', 'referenceImplementation', e.target.checked)
                }
              />{' '}
              CPU reference implementation
            </label>
          )}
          {state.activeMode === 'eval' && (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={config.capabilities.llmJudge}
                  onChange={(e) => updateConfig('capabilities', 'llmJudge', e.target.checked)}
                />{' '}
                LLM judge capability
              </label>
              <label>
                Minimum score{' '}
                <input
                  aria-label="Minimum evaluation score"
                  type="number"
                  min="0"
                  max="1"
                  step="0.01"
                  className="w-16 bg-background border"
                  value={config.evaluation.minimumScore}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      evaluation: { ...config.evaluation, minimumScore: Number(e.target.value) },
                    })
                  }
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={config.evaluation.requireJudge}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      evaluation: { ...config.evaluation, requireJudge: e.target.checked },
                    })
                  }
                />{' '}
                Require judge for this evaluation gate
              </label>
            </>
          )}
          <label>
            <input
              type="checkbox"
              checked={config.permissions.repositoryChanges}
              onChange={(e) => updateConfig('permissions', 'repositoryChanges', e.target.checked)}
            />{' '}
            Permit separately approved repository changes
          </label>
          <label>
            <input
              type="checkbox"
              checked={config.permissions.modelCalls}
              onChange={(e) => updateConfig('permissions', 'modelCalls', e.target.checked)}
            />{' '}
            Permit configured model calls
          </label>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              const value = await client.select(
                projectPath,
                state.activeMode,
                state.revision,
                config
              );
              setState(value);
              setRun(null);
              setApprove(false);
            })
          }
        >
          Save configuration
        </Button>
      </details>
      <details>
        <summary>
          {descriptors.find((d) => d.id === state.activeMode)?.label} research, paper or dataset
          input
        </summary>
        {state.activeMode === 'rea' && (
          <p>
            Set authorized to true only for observations or source you are authorized to inspect.
            Native binaries and live probes require optional isolated workers.
          </p>
        )}
        {state.activeMode === 'paper2code' && (
          <p>
            Supply paper text or a permitted project document. DOI/arXiv alone does not fetch a
            document. Missing datasets and experiments remain unproven.
          </p>
        )}
        {state.activeMode === 'eval' && (
          <p>
            Version the dataset and rubric. Replace the candidate commit SHA with its actual source
            SHA. Outputs are supplied observations; configured model judges are optional.
          </p>
        )}
        <textarea
          aria-label={`${state.activeMode} input`}
          rows={10}
          className="w-full bg-background border rounded p-2 font-mono"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
      </details>
      <div className="flex flex-wrap gap-2 items-center">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              const planned = await client.plan(
                projectPath,
                JSON.parse(input),
                crypto.randomUUID()
              );
              setRun(planned);
              setApprove(false);
              await refresh();
            })
          }
        >
          Plan
        </Button>
        <Button
          size="sm"
          disabled={busy || run?.status !== 'planned'}
          onClick={() =>
            void perform(async () => {
              if (!run) return;
              setRun(
                await client.run(
                  projectPath,
                  run.id,
                  approve && run.sourceSha
                    ? { repositoryChanges: true, sourceSha: run.sourceSha }
                    : undefined
                )
              );
              setApprove(false);
              await refresh();
            })
          }
        >
          Run plan
        </Button>
        <label>
          <input
            type="checkbox"
            checked={approve}
            disabled={busy || !run?.sourceSha || !run.config.permissions.repositoryChanges}
            onChange={(e) => setApprove(e.target.checked)}
          />{' '}
          Approve this plan’s repository changes at{' '}
          {run?.sourceSha?.slice(0, 12) || 'unknown source'}
        </label>
        <select
          aria-label="Mode run history"
          className="bg-background border p-1"
          value={run?.id || ''}
          disabled={busy}
          onChange={(e) => {
            setRun(state.runs.find((r) => r.id === e.target.value) || null);
            setApprove(false);
          }}
        >
          <option value="">Run history</option>
          {state.runs.map((r) => (
            <option key={r.id} value={r.id}>
              {r.mode} · {r.status} · {r.createdAt}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              await refresh();
              if (run) setRun(await client.get(projectPath, run.id));
            })
          }
        >
          Refresh
        </Button>
      </div>
      {run && (
        <div role="status" className="space-y-1">
          <p>
            {run.mode} · {run.status} · {run.evaluation?.verdict || 'Not evaluated'} · {run.id}
          </p>
          <ol className="list-decimal list-inside">
            {run.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {run.evaluation?.reasons.map((reason) => (
            <p key={reason}>{reason}</p>
          ))}
          {run.worktreePath && <p>Isolated reference worktree: {run.worktreePath}</p>}
          {run.tasks.map((task) => (
            <div key={task.id} className="border rounded p-2">
              <strong>{task.title}</strong>
              <p>
                {task.admittedTaskId
                  ? `Argus task: ${task.admittedTaskId}`
                  : 'Proposed task; not executing'}
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={
                  busy ||
                  !approve ||
                  !run.config.permissions.repositoryChanges ||
                  !!task.admittedTaskId ||
                  !run.sourceSha
                }
                onClick={() =>
                  void perform(async () => {
                    setRun(await client.approveTask(projectPath, run.id, task.id, run.sourceSha!));
                    setApprove(false);
                    await refresh();
                  })
                }
              >
                Approve task for existing Argus workflow
              </Button>
            </div>
          ))}
          {run.artifacts.map((a) => (
            <details key={a.name}>
              <summary>
                {a.name} · {a.sha256.slice(0, 12)}
              </summary>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap border rounded p-2">
                {a.content}
              </pre>
            </details>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

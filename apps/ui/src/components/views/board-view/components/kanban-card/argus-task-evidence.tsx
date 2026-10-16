export function ArgusTaskEvidence({ task }: { task: unknown }) {
  if (!task || typeof task !== 'object') return null;
  const value = task as Record<string, unknown>;
  const text = (key: string) => (typeof value[key] === 'string' ? String(value[key]) : '—');
  const loki = value.lokiEvidence as { verdict?: string; notProven?: string[] } | undefined;
  const repairs = ['lokiRepairAttempts', 'julesRepairAttempt', 'seniorGuidedRepairAttempt'].reduce(
    (n, k) => n + (typeof value[k] === 'number' ? Number(value[k]) : 0),
    0
  );
  return (
    <div className="mb-2 rounded border p-2 text-[11px] space-y-1" aria-label="Argus evidence">
      <p className="font-medium">
        Argus · {text('phase')} · {text('executor')}
      </p>
      <p className="truncate" title={text('taskId')}>
        {text('taskId')}
      </p>
      <p className="truncate">Session: {text('julesSessionId')}</p>
      <p>
        PR: {typeof value.prNumber === 'number' ? `#${value.prNumber}` : '—'} · HEAD:{' '}
        <span title={text('prHeadSha')}>{text('prHeadSha').slice(0, 12)}</span>
      </p>
      <p>
        Loki: {loki?.verdict || 'NOT_PROVEN'} · CI: {text('ciState')} · Senior:{' '}
        {text('reviewVerdict')}
      </p>
      <p>
        Repairs: {repairs} · Next: {text('nextAction')}
      </p>
      {typeof value.blockedReason === 'string' && (
        <p className="text-destructive">{value.blockedReason}</p>
      )}
      {typeof value.experimentId === 'string' && <p>Experiment: {value.experimentId}</p>}
      {!!loki?.notProven?.length && (
        <details>
          <summary>Evidence gaps</summary>
          <ul>
            {loki.notProven.map((gap, i) => (
              <li key={i}>{gap}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

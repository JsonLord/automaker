import { useEffect, useState } from 'react';
import { getHttpApiClient } from '@/lib/http-api-client';
import { Button } from '@/components/ui/button';
interface Campaign {
  id: string;
  status: string;
  deadlineAt: string;
  tasksStarted: number;
  tasksCompleted: number;
  tasksBlocked: number;
  stopReason: string | null;
}
export function ArgusCampaignPanel({ projectPath }: { projectPath: string }) {
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState<unknown>(null);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const result = await getHttpApiClient().argus.status(projectPath);
        if (active) {
          setAvailable(true);
          setCampaign(result.campaign);
        }
      } catch {
        if (active) setAvailable(false);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [projectPath]);
  if (!available) return null;
  const control = async (action: 'start' | 'pause' | 'resume' | 'stop' | 'drain') => {
    setBusy(true);
    setError('');
    try {
      const result = await getHttpApiClient().argus.control(projectPath, action);
      setCampaign(result.campaign);
      setReport(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Campaign control failed');
    } finally {
      setBusy(false);
    }
  };
  const remaining = campaign
    ? Math.max(0, Math.ceil((Date.parse(campaign.deadlineAt) - Date.now()) / 60000))
    : 0;
  return (
    <section className="border-b px-4 py-2 text-xs" aria-label="Argus campaign">
      <div className="flex flex-wrap items-center gap-2">
        <strong>Argus campaign</strong>
        <span role="status">
          {campaign
            ? `${campaign.status} · ${remaining} min remaining · ${campaign.tasksCompleted}/${campaign.tasksStarted} completed · ${campaign.tasksBlocked} blocked`
            : 'Ready'}
        </span>
        {!campaign || ['completed', 'expired'].includes(campaign.status) ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void control('start')}>
            Start 8 hours
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void control(
                  campaign.status === 'paused' || campaign.status === 'blocked' ? 'resume' : 'pause'
                )
              }
            >
              {campaign.status === 'paused' || campaign.status === 'blocked' ? 'Resume' : 'Pause'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || campaign.status === 'draining'}
              onClick={() => void control('drain')}
            >
              Drain
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void control('stop')}
            >
              Stop scheduling
            </Button>
          </>
        )}
        {campaign && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void getHttpApiClient()
                .argus.report(projectPath)
                .then(setReport)
                .catch((e) => setError(String(e)));
            }}
          >
            Report
          </Button>
        )}
        {campaign?.stopReason && <span>{campaign.stopReason}</span>}
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {report !== null && (
        <details open>
          <summary>Campaign report</summary>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap">
            {JSON.stringify(report, null, 2)}
          </pre>
        </details>
      )}
    </section>
  );
}

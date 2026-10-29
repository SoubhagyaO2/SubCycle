import { EmptyState, ErrorState, LoadingState, PageHeader } from '../components/States';
import { useApi } from '../context/AuthContext';
import { useResource } from '../hooks/useResource';
import { describeEvent } from '../lib/events';
import { formatDateTime } from '../lib/format';

const DOT: Record<string, string> = { good: 'bg-emerald-500', warn: 'bg-amber-500', bad: 'bg-red-500', neutral: 'bg-slate-400' };
const TONE_WORD: Record<string, string> = { good: 'Positive', warn: 'Needs attention', bad: 'Problem', neutral: 'Info' };

export function HistoryPage() {
  const api = useApi();
  const history = useResource(async (signal) => {
    const [events, plans] = await Promise.all([api.history({ signal }), api.plans({ signal })]);
    return { events, plans: new Map(plans.map((p) => [p.id, p])) };
  }, [api]);

  return (
    <>
      <PageHeader title="Subscription history" />
      {history.loading && <LoadingState label="Loading history" />}
      {history.error && !history.data && <ErrorState error={history.error} onRetry={history.reload} title="Could not load history" />}
      {history.data && history.data.events.length === 0 && <EmptyState title="Nothing here yet">Your subscription events, renewals, failed payments and plan changes will appear here.</EmptyState>}
      {history.data && history.data.events.length > 0 && (
        <ol className="space-y-0 rounded-2xl border border-line bg-surface p-2 shadow-card sm:p-5" aria-label="Subscription events, newest first">
          {[...history.data.events].reverse().map((e) => {
            const d = describeEvent(e, history.data!.plans);
            return (
              <li key={e.id} className="flex gap-3 border-b border-line p-3 last:border-0">
                <span aria-hidden="true" className={`mt-1.5 size-3 shrink-0 rounded-full ${DOT[d.tone]}`} />
                <div className="min-w-0">
                  <p className="font-medium text-ink">
                    {d.title} <span className="sr-only">({TONE_WORD[d.tone]})</span>
                  </p>
                  {d.detail && <p className="text-sm text-ink-2">{d.detail}</p>}
                  <p className="mt-0.5 text-xs text-muted">
                    <time dateTime={e.createdAt}>{formatDateTime(e.createdAt)}</time>
                    {e.fromStatus && e.toStatus && e.fromStatus !== e.toStatus && <span> · {e.fromStatus.replace('_', ' ')} → {e.toStatus.replace('_', ' ')}</span>}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { EmptyState, ErrorState, LoadingState, PageHeader } from '../components/States';
import { Badge } from '../components/StatusBadge';
import { UsageBar } from '../components/UsageBar';
import { useApi } from '../context/AuthContext';
import { useIntentRunner } from '../hooks/useIntentRunner';
import { useResource } from '../hooks/useResource';
import { formatDate, formatDateTime, formatLimit, metricLabel } from '../lib/format';

interface GeneratedReport {
  id: string;
  title: string;
  generatedAt: string;
}

export function UsagePage() {
  const api = useApi();
  const usage = useResource((signal) => api.usage({ signal }), [api]);
  const history = useResource((signal) => api.usageHistory({ signal }), [api]);

  return (
    <>
      <PageHeader title="Usage" />
      <div className="space-y-6">
        <section aria-labelledby="current-usage" className="rounded-2xl border border-line bg-surface p-5 shadow-card">
          <h2 id="current-usage" className="text-lg font-semibold text-ink">
            This billing period
          </h2>
          {usage.loading && <LoadingState label="Loading usage" />}
          {usage.error && !usage.data && (
            usage.error.code === 'SUBSCRIPTION_NOT_FOUND' ? (
              <div className="mt-3">
                <EmptyState title="No subscription" action={<Link to="/pricing" className="rounded-md bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">Choose a plan</Link>}>
                  Usage is tracked once you have a plan.
                </EmptyState>
              </div>
            ) : (
              <ErrorState error={usage.error} onRetry={usage.reload} title="Could not load usage" />
            )
          )}
          {usage.data && (
            <>
              <p className="mt-1 text-sm text-muted">
                {formatDate(usage.data.period.start)} – {formatDate(usage.data.period.end)}. Counters reset when the next period starts.
              </p>
              {!usage.data.subscription.accessAllowed && (
                <Banner tone="warn" title="Usage is currently not allowed" className="mt-3">
                  The server is not allowing usage for your subscription right now (status: {usage.data.subscription.status.replace('_', ' ')}). Check the dashboard for details.
                </Banner>
              )}
              <ul className="mt-2 divide-y divide-line">
                {usage.data.usage.map((m) => (
                  <UsageBar key={m.metric} metric={m} />
                ))}
              </ul>
            </>
          )}
        </section>

        <DemoPanel onChanged={() => { usage.reload(); history.reload(); }} />

        <section aria-labelledby="usage-history" className="rounded-2xl border border-line bg-surface p-5 shadow-card">
          <h2 id="usage-history" className="text-lg font-semibold text-ink">
            Usage history
          </h2>
          {history.loading && <LoadingState label="Loading usage history" />}
          {history.error && !history.data && <ErrorState error={history.error} onRetry={history.reload} title="Could not load usage history" />}
          {history.data && history.data.length === 0 && (
            <div className="mt-3">
              <EmptyState title="No usage recorded yet">Try the demo below to generate some.</EmptyState>
            </div>
          )}
          {history.data && history.data.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[28rem] text-left text-sm">
                <caption className="sr-only">Usage per billing period, newest first</caption>
                <thead className="border-b border-line text-muted">
                  <tr>
                    <th scope="col" className="py-2 pr-3 font-medium">Period starting</th>
                    <th scope="col" className="py-2 font-medium">Usage</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {history.data.map((p) => (
                    <tr key={p.periodStart}>
                      <td className="py-3 pr-3 whitespace-nowrap align-top">
                        {formatDateTime(p.periodStart)} {p.isCurrent && <Badge tone="good">Current</Badge>}
                      </td>
                      <td className="py-3">{p.metrics.map((m) => `${metricLabel(m.metric)}: ${formatLimit(m.used)}`).join(' · ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

/**
 * Demo of server-side enforcement. Each click is ONE new intention; the single-flight runner makes a double click
 * harmless. If the outcome is unknown (network drop) we say so instead of guessing: the server may have counted it.
 */
function DemoPanel({ onChanged }: { onChanged: () => void }) {
  const api = useApi();
  const { run, busy } = useIntentRunner();
  const [reports, setReports] = useState<GeneratedReport[]>([]);
  const [message, setMessage] = useState<{ tone: 'error' | 'warn'; title: string; text: string } | null>(null);

  const generate = async () => {
    setMessage(null);
    const result = await run(`report:${Date.now()}-${reports.length}`, () => api.generateReport());
    if (result.status === 'ignored') return;
    if (result.status === 'ok') {
      setReports((r) => [result.value.report, ...r]);
    } else {
      const e = result.error;
      if (e.code === 'LIMIT_EXCEEDED') {
        const d = e.details as { used?: number; limit?: number; periodEnd?: string };
        setMessage({
          tone: 'error',
          title: 'Limit reached: no report was generated',
          text: `${e.message}. You have used ${d.used ?? '?'} of ${d.limit ?? '?'} API calls${d.periodEnd ? `; your allowance resets on ${formatDate(d.periodEnd)}` : ''}. Upgrade your plan for a higher limit.`,
        });
      } else if (e.outcomeUnknown) {
        setMessage({ tone: 'warn', title: 'We could not confirm the result', text: `${e.message} The report may or may not have been counted: check your usage below before trying again.` });
      } else {
        setMessage({ tone: 'error', title: 'No report was generated', text: e.message });
      }
    }
    onChanged();
  };

  return (
    <section aria-labelledby="demo-heading" className="rounded-2xl border border-line bg-surface p-5 shadow-card">
      <h2 id="demo-heading" className="text-lg font-semibold text-ink">
        Demo: generate a report
      </h2>
      <p className="mt-1 text-sm text-muted">Each report uses 1 API call. The limit is enforced by the server, and usage is only counted when the report is actually created.</p>
      <div className="mt-4">
        <Button onClick={() => void generate()} loading={busy}>
          Generate report
        </Button>
      </div>
      {message && (
        <Banner tone={message.tone} title={message.title} className="mt-4">
          {message.text}
        </Banner>
      )}
      {reports.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-ink">Generated in this session</h3>
          <ul className="mt-1 divide-y divide-line text-sm">
            {reports.map((r) => (
              <li key={r.id} className="flex flex-wrap justify-between gap-2 py-2">
                <span>{r.title}</span>
                <span className="text-muted">{formatDateTime(r.generatedAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

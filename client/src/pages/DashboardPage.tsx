import { Link } from 'react-router-dom';
import { Button } from '../components/Button';
import { EmptyState, ErrorState, LoadingState, PageHeader } from '../components/States';
import { StateBanners, SubscriptionSummary } from '../components/SubscriptionSummary';
import { UsageBar } from '../components/UsageBar';
import { useApi } from '../context/AuthContext';
import { useSubscription } from '../context/SubscriptionContext';
import { useResource } from '../hooks/useResource';
import { formatDate } from '../lib/format';

export function DashboardPage() {
  const { state, subscription, error, refresh } = useSubscription();

  return (
    <>
      <PageHeader title="Dashboard" />
      {state === 'loading' && <LoadingState label="Loading your subscription" />}
      {state === 'error' && error && <ErrorState error={error} onRetry={refresh} title="Could not load your subscription" />}
      {state === 'none' && (
        <EmptyState
          title="You don't have a subscription yet"
          action={
            <Link to="/pricing" className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">
              Choose a plan
            </Link>
          }
        >
          Pick a plan to start. You can change or cancel at any time.
        </EmptyState>
      )}
      {state === 'ready' && subscription && (
        <div className="space-y-6">
          <StateBanners sub={subscription} />
          <SubscriptionSummary sub={subscription} manageLink />
          <UsageSummary />
        </div>
      )}
    </>
  );
}

function UsageSummary() {
  const api = useApi();
  const usage = useResource((signal) => api.usage({ signal }), [api]);

  return (
    <section aria-labelledby="usage-heading" className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="usage-heading" className="text-lg font-semibold text-slate-900">
          Usage this period
        </h2>
        <Link to="/usage" className="text-sm font-medium text-indigo-700 underline underline-offset-2">
          Usage details
        </Link>
      </div>
      {usage.loading && <LoadingState label="Loading usage" />}
      {usage.error && !usage.data && <ErrorState error={usage.error} onRetry={usage.reload} title="Could not load usage" />}
      {usage.data && (
        <>
          <p className="mt-1 text-sm text-slate-600">Counters reset when your next billing period starts on {formatDate(usage.data.period.end)}.</p>
          {usage.data.usage.length === 0 ? <p className="mt-3 text-sm text-slate-700">Your plan does not track any usage.</p> : <ul className="mt-2 divide-y divide-slate-100">{usage.data.usage.map((m) => <UsageBar key={m.metric} metric={m} />)}</ul>}
        </>
      )}
      {usage.error && usage.data && (
        <Button variant="ghost" onClick={usage.reload}>
          Refresh usage
        </Button>
      )}
    </section>
  );
}

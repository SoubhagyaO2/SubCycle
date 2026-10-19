import { Link } from 'react-router-dom';
import type { Subscription } from '../api/types';
import { formatDate, formatDateTime, formatPrice } from '../lib/format';
import { phaseOf } from '../lib/subscriptionState';
import { Banner } from './Banner';
import { StatusBadge } from './StatusBadge';

/**
 * Banners that explain the subscription's state. Everything is chosen from the SERVER's state (status, accessAllowed,
 * flags); dates are only displayed, never compared (B19).
 */
export function StateBanners({ sub }: { sub: Subscription }) {
  const phase = phaseOf(sub);
  const end = formatDate(sub.currentPeriodEnd);
  const grace = sub.graceEndsAt ? formatDateTime(sub.graceEndsAt) : null;

  return (
    <div className="space-y-3">
      {phase === 'renewal_processing' && (
        <Banner tone="warn" title="Your renewal is being processed">
          Your billing period ended on {end}. Access is paused until the renewal completes. This page updates automatically; no action is needed.
        </Banner>
      )}
      {phase === 'grace' && (
        <Banner tone="warn" title="Your last payment failed">
          {sub.cancelAtPeriodEnd ? (
            <>
              You asked to cancel, so we will not try to charge you again. You keep access until {grace}, when your subscription ends.
            </>
          ) : (
            <>
              We could not renew your subscription. You keep access until {grace}.{' '}
              {sub.nextRetryAt && <>We will try again on {formatDateTime(sub.nextRetryAt)}. </>}
              If payment keeps failing your subscription will be canceled.
            </>
          )}
        </Banner>
      )}
      {phase === 'grace_expired' && (
        <Banner tone="error" title="Access is blocked: payment is overdue">
          {sub.cancelAtPeriodEnd
            ? `Your grace period ended on ${grace}. Your cancellation will be completed shortly.`
            : `The grace period ended on ${grace}. A final payment attempt is pending; if it fails your subscription will be canceled.`}
        </Banner>
      )}
      {phase === 'paused' && (
        <Banner tone="info" title="Your subscription is paused">
          Usage and renewals are stopped. When you resume, your current period is extended by the time you were paused.
        </Banner>
      )}
      {sub.cancelAtPeriodEnd && (phase === 'active' || phase === 'paused' || phase === 'renewal_processing') && (
        <Banner tone="warn" title="Cancellation scheduled">
          Your subscription will end on {end}. Any scheduled plan change will not apply.
        </Banner>
      )}
      {sub.pendingPlan && !sub.cancelAtPeriodEnd && (
        <Banner tone="info" title={`Scheduled change to ${sub.pendingPlan.name}`}>
          You keep {sub.plan.name} and its limits until {end}, then move to {sub.pendingPlan.name}.
        </Banner>
      )}
    </div>
  );
}

/** Plan, status and period facts, as reported by the server. */
export function SubscriptionSummary({ sub, manageLink = false }: { sub: Subscription; manageLink?: boolean }) {
  const phase = phaseOf(sub);
  const endLabel =
    sub.status === 'past_due'
      ? 'Grace period ends'
      : sub.cancelAtPeriodEnd
        ? 'Ends on'
        : sub.status === 'paused'
          ? 'Period ends (extended on resume)'
          : 'Renews on';
  const endValue = sub.status === 'past_due' && sub.graceEndsAt ? formatDateTime(sub.graceEndsAt) : formatDate(sub.currentPeriodEnd);

  return (
    <section aria-labelledby="plan-heading" className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="plan-heading" className="text-sm font-medium text-slate-600">
            Current plan
          </h2>
          <p className="text-2xl font-semibold text-slate-900">{sub.plan.name}</p>
          <p className="text-sm text-slate-700">{formatPrice(sub.plan.priceCents, sub.plan.interval)}</p>
        </div>
        <StatusBadge phase={phase} />
      </div>
      <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-slate-600">Current period</dt>
          <dd className="font-medium text-slate-900">
            {formatDate(sub.currentPeriodStart)} – {formatDate(sub.currentPeriodEnd)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-600">{endLabel}</dt>
          <dd className="font-medium text-slate-900">{endValue}</dd>
        </div>
        <div>
          <dt className="text-slate-600">Access</dt>
          <dd className="font-medium text-slate-900">{sub.accessAllowed ? 'Allowed' : 'Not allowed right now'}</dd>
        </div>
      </dl>
      {manageLink && (
        <p className="mt-4">
          <Link to="/manage" className="text-sm font-medium text-indigo-700 underline underline-offset-2">
            Manage plan
          </Link>
        </p>
      )}
    </section>
  );
}

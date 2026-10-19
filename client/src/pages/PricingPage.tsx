import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Plan, Subscription } from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Button } from '../components/Button';
import { PlanCard } from '../components/PlanCard';
import { ErrorState, LoadingState, PageHeader } from '../components/States';
import { useApi } from '../context/AuthContext';
import { useFlash } from '../context/FlashContext';
import { useSubscription } from '../context/SubscriptionContext';
import { useIntentRunner } from '../hooks/useIntentRunner';
import { useResource } from '../hooks/useResource';
import { formatMoney } from '../lib/format';

const linkButton =
  'inline-flex min-h-10 w-full items-center justify-center rounded-md px-4 py-2 text-sm font-medium ring-1 ring-inset ring-indigo-300 text-indigo-800 hover:bg-indigo-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600';

function relationTo(plan: Plan, sub: Subscription): 'current' | 'scheduled' | 'upgrade' | 'downgrade' | 'other_interval' {
  if (plan.id === sub.plan.id) return 'current';
  if (plan.id === sub.pendingPlan?.id) return 'scheduled';
  if (plan.interval !== sub.plan.interval) return 'other_interval';
  return plan.priceCents > sub.plan.priceCents ? 'upgrade' : 'downgrade';
}

export function PricingPage() {
  const api = useApi();
  const plans = useResource((signal) => api.plans({ signal }), [api]);
  const { state, subscription, adopt, refresh } = useSubscription();
  const { run, busy } = useIntentRunner();
  const { showFlash } = useFlash();
  const navigate = useNavigate();
  const [target, setTarget] = useState<Plan | null>(null);
  const [dialogError, setDialogError] = useState<{ message: string; retry: boolean } | null>(null);

  const close = () => {
    setTarget(null);
    setDialogError(null);
  };

  const confirm = async () => {
    if (!target) return;
    const result = await run(`subscribe:${target.id}`, (key) => api.subscribe(target.id, key));
    if (result.status === 'ok') {
      // Only now, after the API confirmed it, do we show success.
      adopt(result.value);
      showFlash({ kind: 'success', text: `You're subscribed to ${target.name}.`, path: '/' });
      close();
      navigate('/');
    } else if (result.status === 'error') {
      setDialogError({ message: result.error.message, retry: result.retrySameKey });
      if (result.error.code === 'INVALID_TRANSITION') refresh();
    }
  };

  return (
    <>
      <PageHeader title="Plans" />
      {plans.loading && <LoadingState label="Loading plans" />}
      {plans.error && !plans.data && <ErrorState error={plans.error} onRetry={plans.reload} title="Could not load plans" />}
      {plans.data && (
        <>
          {state === 'ready' && subscription && (
            <p className="mb-4 text-sm text-slate-700">
              You are on <strong>{subscription.plan.name}</strong>. Upgrade or schedule a downgrade on the{' '}
              <Link to="/manage" className="font-medium text-indigo-700 underline underline-offset-2">
                Manage plan
              </Link>{' '}
              page. Switching between monthly and yearly billing is not supported yet.
            </p>
          )}
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {plans.data.map((plan) => {
              const rel = state === 'ready' && subscription ? relationTo(plan, subscription) : null;
              const badges = rel === 'current' ? ['Current plan'] : rel === 'scheduled' ? ['Scheduled'] : [];
              return (
                <li key={plan.id}>
                  <PlanCard plan={plan} badges={badges} heading="h2">
                    {state === 'loading' && <p className="text-sm text-slate-600">Checking your subscription…</p>}
                    {state === 'none' && (
                      <Button className="w-full" onClick={() => setTarget(plan)} disabled={busy}>
                        {plan.priceCents === 0 ? 'Start for free' : 'Subscribe'}
                      </Button>
                    )}
                    {rel === 'upgrade' && (
                      <Link to={`/manage?plan=${plan.id}`} className={linkButton}>
                        Upgrade
                      </Link>
                    )}
                    {rel === 'downgrade' && (
                      <Link to={`/manage?plan=${plan.id}`} className={linkButton}>
                        Schedule downgrade
                      </Link>
                    )}
                    {rel === 'other_interval' && <p className="text-xs text-slate-600">Switching between monthly and yearly billing is not supported yet.</p>}
                  </PlanCard>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <ConfirmDialog
        open={target !== null}
        title={target ? `Subscribe to ${target.name}` : ''}
        confirmLabel={dialogError?.retry ? 'Retry' : target && target.priceCents > 0 ? `Pay ${formatMoney(target.priceCents)} and subscribe` : 'Start for free'}
        onConfirm={() => void confirm()}
        onCancel={close}
        busy={busy}
        error={dialogError?.message ?? null}
      >
        {target && (
          <>
            {target.priceCents > 0 ? (
              <p>
                You will be charged <strong>{formatMoney(target.priceCents)}</strong> now for the first {target.interval}. Your subscription renews every {target.interval}, and you can cancel at any time.
              </p>
            ) : (
              <p>The Free plan costs nothing. You can upgrade whenever you need more.</p>
            )}
            {dialogError?.retry && <p className="font-medium">Your payment may still be confirming. Retrying is safe: you will not be charged twice.</p>}
          </>
        )}
      </ConfirmDialog>
    </>
  );
}

import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { Plan, Subscription } from '../api/types';
import { Button } from '../components/Button';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { PlanCard } from '../components/PlanCard';
import { EmptyState, ErrorState, LoadingState, PageHeader } from '../components/States';
import { StateBanners, SubscriptionSummary } from '../components/SubscriptionSummary';
import { useApi } from '../context/AuthContext';
import { useFlash } from '../context/FlashContext';
import { useSubscription } from '../context/SubscriptionContext';
import { useIntentRunner } from '../hooks/useIntentRunner';
import { useResource } from '../hooks/useResource';
import { formatDate, formatDateTime, formatDuration, formatMoney } from '../lib/format';
import { allowedActions, type ActionKey } from '../lib/subscriptionState';

type Dialog =
  | { kind: 'upgrade'; plan: Plan }
  | { kind: 'downgrade'; plan: Plan }
  | { kind: 'removePendingChange' | 'pause' | 'resume' | 'cancel' | 'cancelImmediate' | 'reactivate' };

const intentOf = (d: Dialog) => (d.kind === 'upgrade' || d.kind === 'downgrade' ? `${d.kind}:${d.plan.id}` : d.kind);

export function ManagePlanPage() {
  const api = useApi();
  const { state, subscription, error, refresh, adopt } = useSubscription();
  const plans = useResource((signal) => api.plans({ signal }), [api]);
  const { run, busy } = useIntentRunner();
  const { showFlash } = useFlash();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [chosen, setChosen] = useState<Dialog | null>(null);
  const [deepLinkUsed, setDeepLinkUsed] = useState(false);
  const [dialogError, setDialogError] = useState<{ message: string; retry: boolean } | null>(null);

  // Deep link from the Plans page (?plan=<id>): derived from the data, so no effect/state juggling is needed.
  const wanted = params.get('plan');
  const deepLink: Dialog | null = (() => {
    if (!wanted || deepLinkUsed || !subscription || !plans.data) return null;
    const plan = plans.data.find((p) => p.id === wanted);
    if (!plan || plan.interval !== subscription.plan.interval) return null;
    const a = allowedActions(subscription);
    if (plan.priceCents > subscription.plan.priceCents && a.upgrade.allowed) return { kind: 'upgrade', plan };
    if (plan.priceCents < subscription.plan.priceCents && a.downgrade.allowed) return { kind: 'downgrade', plan };
    return null;
  })();
  const dialog: Dialog | null = chosen ?? deepLink;
  const planId = dialog?.kind === 'upgrade' ? dialog.plan.id : null;
  // The upgrade preview is fetched from the server each time the dialog opens; it is only an estimate.
  const preview = useResource(async (signal) => (planId ? api.upgradePreview(planId, { signal }) : null), [planId]);

  const close = () => {
    setChosen(null);
    setDeepLinkUsed(true);
    setDialogError(null);
  };
  const open = (d: Dialog) => {
    setDialogError(null);
    setDeepLinkUsed(true);
    setChosen(d);
  };

  const execute = async () => {
    if (!dialog || !subscription) return;
    const result = await run(intentOf(dialog), (key) => {
      switch (dialog.kind) {
        case 'upgrade':
          return api.upgrade(dialog.plan.id, key);
        case 'downgrade':
          return api.downgrade(dialog.plan.id, key);
        case 'removePendingChange':
          return api.removePendingChange(key);
        case 'pause':
          return api.pause(key);
        case 'resume':
          return api.resume(key);
        case 'cancel':
          return api.cancel(key);
        case 'cancelImmediate':
          return api.cancel(key, true);
        case 'reactivate':
          return api.reactivate(key);
      }
    });
    if (result.status === 'ignored') return;
    if (result.status === 'error') {
      setDialogError({ message: result.error.message, retry: result.retrySameKey });
      // If the server disagrees with what we showed (state moved on), re-sync the screen.
      if (result.error.status === 409 || result.error.code === 'SUBSCRIPTION_NOT_FOUND') refresh();
      return;
    }
    // Success is shown ONLY now: the API answered 2xx with the resulting subscription.
    const done = result.value;
    const kind = dialog.kind;
    close();
    if (kind === 'cancelImmediate') {
      refresh();
      showFlash({ kind: 'success', text: 'Your subscription has been canceled.', path: '/' });
      navigate('/');
      return;
    }
    adopt(done);
    refresh();
    showFlash({ kind: 'success', text: successMessage(kind, done) });
  };

  if (state === 'loading' || plans.loading) return <><PageHeader title="Manage plan" /><LoadingState label="Loading your subscription" /></>;
  if (state === 'error' && error) return <><PageHeader title="Manage plan" /><ErrorState error={error} onRetry={refresh} /></>;
  if (plans.error && !plans.data) return <><PageHeader title="Manage plan" /><ErrorState error={plans.error} onRetry={plans.reload} /></>;
  if (state === 'none' || !subscription || !plans.data) {
    return (
      <>
        <PageHeader title="Manage plan" />
        <EmptyState title="No active subscription" action={<Link to="/pricing" className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">Choose a plan</Link>}>
          Subscribe to a plan first, then you can change it here.
        </EmptyState>
      </>
    );
  }

  const actions = allowedActions(subscription);
  const sameInterval = plans.data.filter((p) => p.interval === subscription.plan.interval && p.id !== subscription.plan.id);
  const upgrades = sameInterval.filter((p) => p.priceCents > subscription.plan.priceCents);
  const downgrades = sameInterval.filter((p) => p.priceCents < subscription.plan.priceCents);
  const hasOtherInterval = plans.data.some((p) => p.interval !== subscription.plan.interval);

  return (
    <>
      <PageHeader title="Manage plan" />
      <div className="space-y-6">
        <StateBanners sub={subscription} />
        <SubscriptionSummary sub={subscription} />

        <Section title="Upgrade" description="Upgrades take effect immediately. You pay the price difference for the rest of the current period.">
          {upgrades.length === 0 ? (
            <p className="text-sm text-slate-600">There is no higher plan with the same billing period.</p>
          ) : (
            <PlanGrid>
              {upgrades.map((p) => (
                <PlanCard key={p.id} plan={p}>
                  <Button className="w-full" onClick={() => open({ kind: 'upgrade', plan: p })} disabled={busy || !actions.upgrade.allowed} aria-describedby={!actions.upgrade.allowed ? 'upgrade-reason' : undefined}>
                    Upgrade to {p.name}
                  </Button>
                </PlanCard>
              ))}
            </PlanGrid>
          )}
          {!actions.upgrade.allowed && <Reason id="upgrade-reason">{actions.upgrade.reason}</Reason>}
        </Section>

        <Section title="Downgrade" description="A downgrade is scheduled for the end of the current period. You keep your current plan and limits until then.">
          {downgrades.length === 0 ? (
            <p className="text-sm text-slate-600">There is no lower plan with the same billing period.</p>
          ) : (
            <PlanGrid>
              {downgrades.map((p) => (
                <PlanCard key={p.id} plan={p} badges={subscription.pendingPlan?.id === p.id ? ['Scheduled'] : []}>
                  <Button
                    variant="secondary"
                    className="w-full"
                    onClick={() => open({ kind: 'downgrade', plan: p })}
                    disabled={busy || !actions.downgrade.allowed || subscription.pendingPlan?.id === p.id}
                    aria-describedby={!actions.downgrade.allowed ? 'downgrade-reason' : undefined}
                  >
                    {subscription.pendingPlan?.id === p.id ? 'Already scheduled' : `Schedule downgrade to ${p.name}`}
                  </Button>
                </PlanCard>
              ))}
            </PlanGrid>
          )}
          {!actions.downgrade.allowed && <Reason id="downgrade-reason">{actions.downgrade.reason}</Reason>}
          {hasOtherInterval && <p className="mt-3 text-xs text-slate-600">Switching between monthly and yearly billing is not supported yet.</p>}
        </Section>

        {subscription.pendingPlan && (
          <Section title="Scheduled plan change" description={`You will move to ${subscription.pendingPlan.name} on ${formatDate(subscription.currentPeriodEnd)}.`}>
            <Button variant="secondary" onClick={() => open({ kind: 'removePendingChange' })} disabled={busy || !actions.removePendingChange.allowed}>
              Keep my current plan instead
            </Button>
          </Section>
        )}

        <Section title="Pause or resume" description="While paused you cannot use the product and no renewal is charged. Resuming extends your period by the time you were paused.">
          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" onClick={() => open({ kind: 'pause' })} disabled={busy || !actions.pause.allowed} aria-describedby={!actions.pause.allowed ? 'pause-reason' : undefined}>
              Pause subscription
            </Button>
            <Button variant="secondary" onClick={() => open({ kind: 'resume' })} disabled={busy || !actions.resume.allowed} aria-describedby={!actions.resume.allowed ? 'resume-reason' : undefined}>
              Resume subscription
            </Button>
          </div>
          {!actions.pause.allowed && subscription.status !== 'paused' && <Reason id="pause-reason">{actions.pause.reason}</Reason>}
          {!actions.resume.allowed && subscription.status === 'paused' && <Reason id="resume-reason">{actions.resume.reason}</Reason>}
        </Section>

        <Section title="Cancel subscription" description="Cancellation takes effect at the end of your current period; you keep access until then.">
          <div className="flex flex-wrap gap-3">
            {subscription.cancelAtPeriodEnd ? (
              <Button onClick={() => open({ kind: 'reactivate' })} disabled={busy || !actions.reactivate.allowed} aria-describedby={!actions.reactivate.allowed ? 'reactivate-reason' : undefined}>
                Keep my subscription (undo cancellation)
              </Button>
            ) : (
              <Button variant="danger" onClick={() => open({ kind: 'cancel' })} disabled={busy || !actions.cancel.allowed} aria-describedby={!actions.cancel.allowed ? 'cancel-reason' : undefined}>
                Cancel at end of period
              </Button>
            )}
            {subscription.status === 'past_due' && (
              <Button variant="danger" onClick={() => open({ kind: 'cancelImmediate' })} disabled={busy}>
                Cancel immediately
              </Button>
            )}
          </div>
          {subscription.cancelAtPeriodEnd && !actions.reactivate.allowed && <Reason id="reactivate-reason">{actions.reactivate.reason}</Reason>}
          {!subscription.cancelAtPeriodEnd && !actions.cancel.allowed && <Reason id="cancel-reason">{actions.cancel.reason}</Reason>}
        </Section>
      </div>

      <ConfirmDialog
        open={dialog !== null}
        title={dialog ? titleOf(dialog) : ''}
        confirmLabel={dialogError?.retry ? 'Retry' : dialog ? confirmLabelOf(dialog, preview.data?.amountCents) : ''}
        onConfirm={() => void execute()}
        onCancel={close}
        busy={busy}
        confirmDisabled={dialog?.kind === 'upgrade' && (preview.loading || preview.error !== null || !preview.data)}
        danger={dialog?.kind === 'cancel' || dialog?.kind === 'cancelImmediate'}
        error={dialogError?.message ?? null}
      >
        {dialog && <DialogBody dialog={dialog} sub={subscription} preview={preview} />}
        {dialogError?.retry && <p className="font-medium">The outcome is not confirmed yet. Retrying is safe: it will not be applied or charged twice.</p>}
      </ConfirmDialog>
    </>
  );
}

function titleOf(d: Dialog): string {
  switch (d.kind) {
    case 'upgrade':
      return `Upgrade to ${d.plan.name}`;
    case 'downgrade':
      return `Schedule downgrade to ${d.plan.name}`;
    case 'removePendingChange':
      return 'Keep your current plan?';
    case 'pause':
      return 'Pause your subscription?';
    case 'resume':
      return 'Resume your subscription?';
    case 'cancel':
      return 'Cancel at the end of your period?';
    case 'cancelImmediate':
      return 'Cancel immediately?';
    case 'reactivate':
      return 'Undo your cancellation?';
  }
}

function confirmLabelOf(d: Dialog, previewAmount: number | undefined): string {
  switch (d.kind) {
    case 'upgrade':
      return previewAmount && previewAmount > 0 ? `Confirm and pay ${formatMoney(previewAmount)}` : 'Confirm upgrade';
    case 'downgrade':
      return 'Schedule downgrade';
    case 'removePendingChange':
      return 'Keep current plan';
    case 'pause':
      return 'Pause subscription';
    case 'resume':
      return 'Resume subscription';
    case 'cancel':
      return 'Cancel at period end';
    case 'cancelImmediate':
      return 'Cancel immediately';
    case 'reactivate':
      return 'Undo cancellation';
  }
}

/** Wording uses what the server returned, never what we expected. */
function successMessage(kind: Dialog['kind'], sub: Subscription): string {
  switch (kind) {
    case 'upgrade':
      return `You are now on ${sub.plan.name}.`;
    case 'downgrade':
      return `Downgrade to ${sub.pendingPlan?.name ?? 'the new plan'} is scheduled for ${formatDate(sub.currentPeriodEnd)}. You keep ${sub.plan.name} until then.`;
    case 'removePendingChange':
      return `Your scheduled change was removed. You will stay on ${sub.plan.name}.`;
    case 'pause':
      return 'Your subscription is paused.';
    case 'resume':
      return `Your subscription is active again. Your current period now ends ${formatDate(sub.currentPeriodEnd)}.`;
    case 'cancel':
      return sub.status === 'past_due' && sub.graceEndsAt
        ? `Cancellation scheduled. We will not try to charge you again, and you keep access until ${formatDateTime(sub.graceEndsAt)}.`
        : `Cancellation scheduled. You keep access until ${formatDate(sub.currentPeriodEnd)}.`;
    case 'cancelImmediate':
      return 'Your subscription has been canceled.';
    case 'reactivate':
      return 'Your cancellation was undone. Your subscription will keep renewing.';
  }
}

function DialogBody({ dialog, sub, preview }: { dialog: Dialog; sub: Subscription; preview: ReturnType<typeof useResource<import('../api/types').UpgradePreview | null>> }) {
  const end = formatDate(sub.currentPeriodEnd);
  switch (dialog.kind) {
    case 'upgrade':
      if (preview.loading) return <p role="status">Calculating the upgrade price…</p>;
      if (preview.error) return <p>We could not calculate the price: {preview.error.message}</p>;
      if (!preview.data) return null;
      return (
        <>
          <p>
            Upgrade from <strong>{sub.plan.name}</strong> to <strong>{dialog.plan.name}</strong> ({formatMoney(dialog.plan.priceCents)} / {dialog.plan.interval}). The change applies immediately.
          </p>
          <dl className="rounded-md bg-slate-50 p-3">
            <div className="flex justify-between gap-3">
              <dt>Time left in this period</dt>
              <dd>
                {formatDuration(preview.data.remainingMs)} of {formatDuration(preview.data.totalMs)}
              </dd>
            </div>
            <div className="mt-1 flex justify-between gap-3 font-semibold text-slate-900">
              <dt>Estimated charge now</dt>
              <dd>{preview.data.chargeRequired ? formatMoney(preview.data.amountCents) : 'No charge'}</dd>
            </div>
          </dl>
          <p className="text-xs text-slate-600">
            This is an estimate. The final amount is calculated by the server when you confirm. Your upgrade is only complete once you see the confirmation.
          </p>
        </>
      );
    case 'downgrade':
      return (
        <p>
          You will move to <strong>{dialog.plan.name}</strong> on {end}. Until then you keep <strong>{sub.plan.name}</strong> and its limits. No refund is issued for the current period.
        </p>
      );
    case 'removePendingChange':
      return <p>The scheduled move to {sub.pendingPlan?.name} will be removed and you will stay on {sub.plan.name}.</p>;
    case 'pause':
      return <p>Usage and renewals stop until you resume. Your scheduled plan change and any cancellation stay in place.</p>;
    case 'resume':
      return <p>Your subscription becomes active again and your current period is extended by the time you were paused. You will not be charged now.</p>;
    case 'cancel':
      return sub.status === 'past_due' ? (
        <p>
          We will stop trying to charge you and your subscription will end when the grace period finishes
          {sub.graceEndsAt ? ` (${formatDateTime(sub.graceEndsAt)})` : ''}. You keep access until then.
        </p>
      ) : (
        <p>
          Your subscription will end on {end} and you keep access until then. A scheduled plan change will be dropped. You can undo this before it takes effect.
        </p>
      );
    case 'cancelImmediate':
      return <p>Your subscription ends right now and access stops immediately. This cannot be undone; you would need to subscribe again.</p>;
    case 'reactivate':
      return <p>Your subscription will keep renewing as normal.</p>;
  }
}

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  const id = `sec-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  return (
    <section aria-labelledby={id} className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <h2 id={id} className="text-lg font-semibold text-slate-900">
        {title}
      </h2>
      <p className="mt-1 text-sm text-slate-600">{description}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

const PlanGrid = ({ children }: { children: ReactNode }) => <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>;
const Reason = ({ id, children }: { id: string; children: ReactNode }) => (
  <p id={id} className="mt-3 text-sm text-slate-600">
    {children}
  </p>
);

export type { ActionKey };

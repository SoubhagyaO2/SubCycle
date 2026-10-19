import type { SubscriptionStatus } from '../lib/access';

/**
 * Pure subscription state machine for USER-initiated actions (docs/STATE_MACHINE.md rows 1-8).
 * System transitions (renewal job, retries) arrive with the jobs stage.
 * It decides ONLY whether an action is allowed from the current state; amounts, plans and side effects live in the service.
 */
export type Action =
  | 'subscribe'
  | 'upgrade'
  | 'downgrade'
  | 'removePendingChange'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'cancelImmediate'
  | 'reactivate';

export interface SubscriptionSnapshot {
  status: SubscriptionStatus;
  cancelAtPeriodEnd: boolean;
  hasPendingPlan: boolean;
  currentPeriodEnd: Date;
}

export type TransitionDecision =
  | { ok: true; to: SubscriptionStatus }
  | { ok: false; kind: 'not_found' | 'conflict' | 'validation'; reason: string; message: string };

const conflict = (reason: string, message: string): TransitionDecision => ({ ok: false, kind: 'conflict', reason, message });
const ok = (to: SubscriptionStatus): TransitionDecision => ({ ok: true, to });

export function decide(action: Action, sub: SubscriptionSnapshot | null, now: Date): TransitionDecision {
  if (action === 'subscribe') {
    return sub === null
      ? ok('active')
      : conflict('already_subscribed', 'You already have a subscription. Change plans from the Manage Plan page.');
  }
  if (sub === null) return { ok: false, kind: 'not_found', reason: 'no_subscription', message: 'No active subscription found' };
  if (sub.status === 'canceled') return conflict('subscription_canceled', 'This subscription has been canceled');
  const { status } = sub;

  switch (action) {
    case 'upgrade':
      return status === 'active' ? ok('active') : conflict(`cannot_upgrade_from_${status}`, `Cannot upgrade a ${status} subscription`);

    case 'downgrade':
      return status === 'active' || status === 'paused'
        ? ok(status)
        : conflict(`cannot_downgrade_from_${status}`, `Cannot schedule a downgrade for a ${status} subscription`);

    case 'removePendingChange':
      return sub.hasPendingPlan ? ok(status) : conflict('no_pending_change', 'There is no scheduled plan change to remove');

    case 'pause':
      return status === 'active' ? ok('paused') : conflict(`cannot_pause_from_${status}`, `Cannot pause a ${status} subscription`);

    case 'resume':
      return status === 'paused' ? ok('active') : conflict(`cannot_resume_from_${status}`, 'Only a paused subscription can be resumed');

    case 'cancel':
      if (status === 'paused') return conflict('cancel_while_paused', 'Resume the subscription before canceling it');
      if (sub.cancelAtPeriodEnd) return conflict('already_canceling', 'Cancellation is already scheduled');
      return ok(status);

    case 'cancelImmediate':
      if (status !== 'past_due') {
        return { ok: false, kind: 'validation', reason: 'immediate_requires_past_due', message: 'Immediate cancellation is only available for a past-due subscription' };
      }
      return ok('canceled');

    case 'reactivate':
      if (!sub.cancelAtPeriodEnd) return conflict('not_canceling', 'No scheduled cancellation to undo');
      if (status === 'paused') return conflict('reactivate_while_paused', 'Resume the subscription before reactivating it');
      if (status === 'active' && now.getTime() >= sub.currentPeriodEnd.getTime()) {
        return conflict('period_already_ended', 'The subscription period has already ended');
      }
      return ok(status);
  }
}

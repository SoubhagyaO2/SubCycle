import type { Subscription } from '../api/types';

/**
 * How the UI describes a subscription. It is driven ONLY by the server's fields (`status`, `accessAllowed`, flags):
 * the UI never compares dates to decide access, so it always agrees with the backend's hasAccess policy (B19),
 * including the period_ended -> past_due transition when a renewal fails.
 */
export type Phase = 'active' | 'renewal_processing' | 'grace' | 'grace_expired' | 'paused' | 'canceled';
export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

export function phaseOf(sub: Pick<Subscription, 'status' | 'accessAllowed'>): Phase {
  switch (sub.status) {
    case 'active':
      return sub.accessAllowed ? 'active' : 'renewal_processing';
    case 'past_due':
      return sub.accessAllowed ? 'grace' : 'grace_expired';
    case 'paused':
      return 'paused';
    case 'canceled':
      return 'canceled';
  }
}

export const PHASE_LABEL: Record<Phase, string> = {
  active: 'Active',
  renewal_processing: 'Renewal processing',
  grace: 'Payment failed (grace period)',
  grace_expired: 'Past due (access blocked)',
  paused: 'Paused',
  canceled: 'Canceled',
};

export const PHASE_TONE: Record<Phase, Tone> = {
  active: 'good',
  renewal_processing: 'warn',
  grace: 'warn',
  grace_expired: 'bad',
  paused: 'neutral',
  canceled: 'neutral',
};

export type ActionKey = 'upgrade' | 'downgrade' | 'removePendingChange' | 'pause' | 'resume' | 'cancel' | 'cancelImmediate' | 'reactivate';
export interface ActionState {
  allowed: boolean;
  /** Shown next to a disabled action. The server remains the authority and its message is displayed if it disagrees. */
  reason?: string;
}

/** Hints that mirror the backend's transition table (docs/STATE_MACHINE.md); they never replace the server's answer. */
export function allowedActions(sub: Subscription): Record<ActionKey, ActionState> {
  const phase = phaseOf(sub);
  const active = phase === 'active';
  const waitForRenewal = 'Available once your renewal has been processed.';
  const no = (reason: string): ActionState => ({ allowed: false, reason });
  const yes: ActionState = { allowed: true };

  return {
    upgrade: active ? yes : phase === 'renewal_processing' ? no(waitForRenewal) : no('Upgrades are only available while your subscription is active.'),
    downgrade: sub.status === 'active' || sub.status === 'paused' ? yes : no('Plan changes are not available while payment is overdue.'),
    removePendingChange: sub.pendingPlan ? yes : no('There is no scheduled plan change.'),
    pause: active ? yes : phase === 'renewal_processing' ? no(waitForRenewal) : no('Only an active subscription can be paused.'),
    resume: sub.status === 'paused' ? yes : no('Only a paused subscription can be resumed.'),
    cancel:
      sub.status === 'paused'
        ? no('Resume your subscription before canceling it.')
        : (sub.status === 'active' || sub.status === 'past_due') && !sub.cancelAtPeriodEnd
          ? yes
          : no(sub.cancelAtPeriodEnd ? 'Cancellation is already scheduled.' : 'This subscription cannot be canceled.'),
    cancelImmediate: sub.status === 'past_due' ? yes : no('Only available while payment is overdue.'),
    reactivate:
      sub.cancelAtPeriodEnd && (phase === 'active' || sub.status === 'past_due')
        ? yes
        : sub.cancelAtPeriodEnd && sub.status === 'paused'
          ? no('Resume your subscription before reactivating it.')
          : no('No cancellation is scheduled.'),
  };
}

import type { HistoryEvent, Plan } from '../api/types';
import { formatDate, formatDateTime, formatMoney } from './format';

export interface DescribedEvent {
  title: string;
  detail: string | null;
  tone: 'good' | 'warn' | 'bad' | 'neutral';
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** Human wording for the audit events (backend meta keys are snake_case). */
export function describeEvent(event: HistoryEvent, plans: Map<string, Plan>): DescribedEvent {
  const m = event.meta;
  const plan = (id: unknown) => {
    const p = typeof id === 'string' ? plans.get(id) : undefined;
    return p ? p.name : 'a plan';
  };
  const amount = num(m.amount_cents);
  const paid = amount && amount > 0 ? ` (${formatMoney(amount)})` : '';
  const when = (v: unknown) => {
    const s = str(v);
    return s ? formatDate(s) : null;
  };

  switch (event.type) {
    case 'subscribed':
      return { title: `Subscribed to ${plan(m.plan_id)}`, detail: amount ? `Charged ${formatMoney(amount)}.` : 'No charge.', tone: 'good' };
    case 'upgraded':
      return {
        title: `Upgraded to ${plan(m.to_plan_id)}`,
        detail: amount ? `Prorated charge ${formatMoney(amount)}.` : 'No charge for the remaining time.',
        tone: 'good',
      };
    case 'downgrade_scheduled':
      return { title: `Downgrade to ${plan(m.to_plan_id)} scheduled`, detail: when(m.effective_at) ? `Takes effect ${when(m.effective_at)}.` : null, tone: 'neutral' };
    case 'downgrade_cleared':
      return { title: 'Scheduled downgrade removed', detail: m.reason === 'upgrade' ? 'Replaced by your upgrade.' : null, tone: 'neutral' };
    case 'downgrade_applied':
      return { title: `Moved to ${plan(m.to_plan_id)}`, detail: 'Your scheduled downgrade took effect.', tone: 'neutral' };
    case 'paused':
      return { title: 'Subscription paused', detail: 'Usage and renewals are stopped until you resume.', tone: 'neutral' };
    case 'resumed': {
      const end = when(m.new_period_end);
      return { title: 'Subscription resumed', detail: end ? `Current period now ends ${end}.` : null, tone: 'good' };
    }
    case 'cancel_scheduled': {
      const end = when(m.effective_at);
      return { title: 'Cancellation scheduled', detail: end ? `Access continues until ${end}.` : null, tone: 'warn' };
    }
    case 'reactivated':
      return { title: 'Cancellation undone', detail: 'Your subscription will keep renewing.', tone: 'good' };
    case 'renewed': {
      const end = when(m.period_end);
      const recovered = m.recovered_from_past_due === true ? ' Recovered after a failed payment.' : '';
      const detail = `${amount ? `Charged ${formatMoney(amount)}. ` : ''}${end ? `Next renewal ${end}.` : ''}${recovered}`.trim();
      return { title: 'Subscription renewed', detail: detail || null, tone: 'good' };
    }
    case 'renewal_failed': {
      const grace = str(m.grace_ends_at);
      const next = str(m.next_retry_at);
      const final = m.final === true;
      const detail = final
        ? `We could not collect ${formatMoney(amount ?? 0)} after several attempts.`
        : `${grace ? `Access continues until ${formatDateTime(grace)}. ` : ''}${next ? `Next attempt ${formatDateTime(next)}.` : ''}`.trim();
      return { title: final ? 'Final renewal payment failed' : 'Renewal payment failed', detail: detail || null, tone: 'bad' };
    }
    case 'canceled': {
      const why = m.reason === 'payment_failed' ? 'Canceled after the renewal payment failed.' : m.immediate === true ? 'Canceled immediately at your request.' : 'Canceled at your request.';
      return { title: 'Subscription canceled', detail: why, tone: 'bad' };
    }
    case 'charge_discarded':
      return {
        title: 'Payment refunded',
        detail: `A payment${paid} was taken while your subscription changed, so it was not applied and is being refunded.`,
        tone: 'warn',
      };
    default:
      return { title: event.type.replace(/_/g, ' '), detail: null, tone: 'neutral' };
  }
}

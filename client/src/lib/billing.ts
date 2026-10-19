import type { BillingOperation, Invoice } from '../api/types';
import type { Tone } from './subscriptionState';

export interface StatusView {
  label: string;
  tone: Tone;
  note?: string;
}

/** Invoice states: paid / failed / refunded are three distinct things and are never merged. */
export function invoiceStatus(status: Invoice['status']): StatusView {
  switch (status) {
    case 'paid':
      return { label: 'Paid', tone: 'good' };
    case 'failed':
      return { label: 'Payment failed', tone: 'bad' };
    case 'refunded':
      return { label: 'Refunded', tone: 'neutral' };
  }
}

export const INVOICE_KIND: Record<Invoice['kind'], string> = {
  initial: 'Subscription payment',
  upgrade_proration: 'Upgrade (prorated)',
  renewal: 'Renewal',
};

const OPERATION_KIND: Record<BillingOperation['kind'], string> = {
  initial: 'Subscription payment',
  upgrade: 'Upgrade payment',
  renewal: 'Renewal payment',
  other: 'Payment',
};

export function operationLabel(op: BillingOperation): string {
  return op.type === 'refund' ? `Refund of ${OPERATION_KIND[op.kind].toLowerCase()}` : OPERATION_KIND[op.kind];
}

/** Payment attempts, including ones whose outcome is still unknown (pending) and refunds that failed. */
export function operationStatus(op: BillingOperation): StatusView {
  if (op.type === 'charge') {
    switch (op.status) {
      case 'pending':
        return { label: 'In progress', tone: 'warn', note: 'We are confirming this payment with the payment provider. It is not counted as paid until it is confirmed.' };
      case 'succeeded':
        return { label: 'Succeeded', tone: 'good' };
      case 'failed':
        return { label: 'Failed', tone: 'bad', ...(op.errorMessage ? { note: op.errorMessage } : {}) };
    }
  }
  switch (op.status) {
    case 'pending':
      return { label: 'Refund pending', tone: 'warn', note: 'The refund has been recorded and is being sent to the payment provider.' };
    case 'succeeded':
      return { label: 'Refunded', tone: 'neutral' };
    case 'failed':
      return {
        label: 'Refund failed',
        tone: 'bad',
        note: `This refund could not be completed and needs attention. Please contact support and quote reference ${op.id}.${op.errorMessage ? ` (${op.errorMessage})` : ''}`,
      };
  }
}

/** Mirrors the backend response shapes (server/src/services/*). Nothing here is hardcoded data. */

export type SubscriptionStatus = 'active' | 'paused' | 'past_due' | 'canceled';
export type Interval = 'month' | 'year';

export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface AuthResult {
  user: User;
  token: string;
  expiresAt: string;
}

export interface Plan {
  id: string;
  code: string;
  name: string;
  priceCents: number;
  interval: Interval;
  /** A metric's limit: a number, or null = unlimited. */
  limits: Record<string, number | null>;
}

export interface Subscription {
  id: string;
  status: SubscriptionStatus;
  plan: Plan;
  pendingPlan: Plan | null;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  cancelRequestedAt: string | null;
  pausedAt: string | null;
  canceledAt: string | null;
  cancelReason: string | null;
  pastDueSince: string | null;
  graceEndsAt: string | null;
  retryCount: number;
  nextRetryAt: string | null;
  /** The server's verdict (B19). The UI never derives access from dates. */
  accessAllowed: boolean;
  createdAt: string;
}

export interface UpgradePreview {
  fromPlan: Plan;
  toPlan: Plan;
  amountCents: number;
  chargeRequired: boolean;
  remainingMs: number;
  totalMs: number;
  periodStart: string;
  periodEnd: string;
  computedAt: string;
}

export interface Invoice {
  id: string;
  subscriptionId: string;
  kind: 'initial' | 'upgrade_proration' | 'renewal';
  status: 'paid' | 'failed' | 'refunded';
  amountCents: number;
  description: string;
  billingPeriodStart: string;
  createdAt: string;
}

export interface HistoryEvent {
  id: string;
  subscriptionId: string;
  type: string;
  fromStatus: SubscriptionStatus | null;
  toStatus: SubscriptionStatus | null;
  meta: Record<string, unknown>;
  createdAt: string;
}

export interface MetricUsage {
  metric: string;
  used: number;
  limit: number | null;
  remaining: number | null;
  unlimited: boolean;
}

export interface UsageReport {
  subscription: { id: string; status: SubscriptionStatus; accessAllowed: boolean; graceEndsAt: string | null };
  period: { start: string; end: string };
  usage: MetricUsage[];
}

export interface UsageHistoryPeriod {
  periodStart: string;
  isCurrent: boolean;
  metrics: { metric: string; used: number }[];
}

export interface BillingOperation {
  id: string;
  type: 'charge' | 'refund';
  status: 'pending' | 'succeeded' | 'failed';
  kind: 'initial' | 'upgrade' | 'renewal' | 'other';
  amountCents: number;
  attempt: number;
  reason: string | null;
  errorMessage: string | null;
  invoiceId: string | null;
  refundOfOperationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DemoReport {
  report: { id: string; title: string; generatedAt: string };
  usage: MetricUsage;
}

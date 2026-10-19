import type { Pool, PoolClient } from 'pg';
import type { SubscriptionStatus } from '../lib/access';
import type { PlanInterval } from '../lib/periods';

export type Queryable = Pool | PoolClient;

export interface PlanRow {
  id: string;
  code: string;
  name: string;
  price_cents: number;
  interval: PlanInterval;
  limits: Record<string, number>;
}

export interface SubscriptionRow {
  id: string;
  user_id: string;
  plan_id: string;
  pending_plan_id: string | null;
  status: SubscriptionStatus;
  current_period_start: Date;
  current_period_end: Date;
  cancel_at_period_end: boolean;
  cancel_requested_at: Date | null;
  paused_at: Date | null;
  canceled_at: Date | null;
  cancel_reason: 'user_requested' | 'payment_failed' | null;
  past_due_since: Date | null;
  retry_count: number;
  next_retry_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export type EventType =
  | 'subscribed'
  | 'upgraded'
  | 'downgrade_scheduled'
  | 'downgrade_cleared'
  | 'downgrade_applied'
  | 'paused'
  | 'resumed'
  | 'cancel_scheduled'
  | 'reactivated'
  | 'renewed'
  | 'renewal_failed'
  | 'canceled'
  | 'charge_discarded';

const PLAN_COLUMNS = 'id, code, name, price_cents, interval, limits';

export async function listPlans(q: Queryable): Promise<PlanRow[]> {
  const { rows } = await q.query<PlanRow>(`SELECT ${PLAN_COLUMNS} FROM plans ORDER BY price_cents, interval, code`);
  return rows;
}

export async function getPlan(q: Queryable, id: string): Promise<PlanRow | null> {
  const { rows } = await q.query<PlanRow>(`SELECT ${PLAN_COLUMNS} FROM plans WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/** Locks (FOR UPDATE) the caller's single non-canceled subscription. Authorization is built into the query. */
export async function lockOpenSubscription(client: PoolClient, userId: string): Promise<SubscriptionRow | null> {
  const { rows } = await client.query<SubscriptionRow>(
    `SELECT * FROM subscriptions WHERE user_id = $1 AND status <> 'canceled' FOR UPDATE`,
    [userId],
  );
  return rows[0] ?? null;
}

export async function getOpenSubscription(q: Queryable, userId: string): Promise<SubscriptionRow | null> {
  const { rows } = await q.query<SubscriptionRow>(`SELECT * FROM subscriptions WHERE user_id = $1 AND status <> 'canceled'`, [userId]);
  return rows[0] ?? null;
}

export async function getSubscription(q: Queryable, id: string): Promise<SubscriptionRow | null> {
  const { rows } = await q.query<SubscriptionRow>('SELECT * FROM subscriptions WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/** Serialises everything that concerns one user's (not yet existing) subscription, e.g. subscribe. */
export async function lockUser(client: PoolClient, userId: string): Promise<void> {
  await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
}

export interface NewEvent {
  subscriptionId: string;
  type: EventType;
  fromStatus: SubscriptionStatus | null;
  toStatus: SubscriptionStatus | null;
  meta: Record<string, unknown>;
  at: Date;
}

/** Always call inside the same transaction as the state change it describes. */
export async function insertEvent(client: PoolClient, e: NewEvent): Promise<void> {
  await client.query(
    `INSERT INTO subscription_events (subscription_id, type, from_status, to_status, meta, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [e.subscriptionId, e.type, e.fromStatus, e.toStatus, JSON.stringify(e.meta), e.at],
  );
}

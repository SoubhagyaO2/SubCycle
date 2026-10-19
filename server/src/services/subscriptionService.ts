import type { PoolClient } from 'pg';
import type { ChargeInput } from '../billing/provider';
import { graceEndsAt, hasAccess } from '../lib/access';
import { AppError, conflict, notFound, validationError } from '../lib/errors';
import { addInterval } from '../lib/periods';
import { computeProration } from '../lib/proration';
import {
  getOpenSubscription,
  getPlan,
  insertEvent,
  listPlans as listPlanRows,
  lockOpenSubscription,
  lockUser,
  type PlanRow,
  type Queryable,
  type SubscriptionRow,
} from '../db/subscriptionRepo';
import { withTransaction } from '../db/transaction';
import { decide, type Action, type SubscriptionSnapshot, type TransitionDecision } from './stateMachine';
import {
  allocateChargeAttempt,
  callProvider,
  getOperation,
  type AllocateResult,
  type BillingDeps,
  type OperationRow,
} from './billingOperations';
import {
  processRefund,
  settleCharge,
  writeUpgrade,
  type InitialMeta,
  type SettleResult,
  type UpgradeMeta,
} from './chargeSettlement';

const DAY_MS = 24 * 60 * 60 * 1000;

// ---- views -------------------------------------------------------------------------------------------------------

export interface PlanView {
  id: string;
  code: string;
  name: string;
  priceCents: number;
  interval: 'month' | 'year';
  limits: Record<string, number>;
}

export interface SubscriptionView {
  id: string;
  status: SubscriptionRow['status'];
  plan: PlanView;
  pendingPlan: PlanView | null;
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
  /** Server-computed so the frontend never re-implements the grace rule. */
  accessAllowed: boolean;
  createdAt: string;
}

const planView = (p: PlanRow): PlanView => ({ id: p.id, code: p.code, name: p.name, priceCents: p.price_cents, interval: p.interval, limits: p.limits });
const isoOrNull = (d: Date | null): string | null => (d ? d.toISOString() : null);

async function buildView(q: Queryable, row: SubscriptionRow, now: Date): Promise<SubscriptionView> {
  const plan = (await getPlan(q, row.plan_id))!;
  const pending = row.pending_plan_id ? await getPlan(q, row.pending_plan_id) : null;
  return {
    id: row.id,
    status: row.status,
    plan: planView(plan),
    pendingPlan: pending ? planView(pending) : null,
    currentPeriodStart: row.current_period_start.toISOString(),
    currentPeriodEnd: row.current_period_end.toISOString(),
    cancelAtPeriodEnd: row.cancel_at_period_end,
    cancelRequestedAt: isoOrNull(row.cancel_requested_at),
    pausedAt: isoOrNull(row.paused_at),
    canceledAt: isoOrNull(row.canceled_at),
    cancelReason: row.cancel_reason,
    pastDueSince: isoOrNull(row.past_due_since),
    graceEndsAt: row.past_due_since ? graceEndsAt(row.past_due_since).toISOString() : null,
    retryCount: row.retry_count,
    nextRetryAt: isoOrNull(row.next_retry_at),
    accessAllowed: hasAccess({ status: row.status, pastDueSince: row.past_due_since, currentPeriodEnd: row.current_period_end }, now),
    createdAt: row.created_at.toISOString(),
  };
}

const snapshot = (row: SubscriptionRow | null): SubscriptionSnapshot | null =>
  row
    ? { status: row.status, cancelAtPeriodEnd: row.cancel_at_period_end, hasPendingPlan: row.pending_plan_id !== null, currentPeriodEnd: row.current_period_end }
    : null;

/** Turns a state-machine refusal into the standard HTTP error (409 for state, 404 if none, 400 for bad input). */
function assertAllowed(decision: TransitionDecision, action: Action, sub: SubscriptionRow | null): void {
  if (decision.ok) return;
  const details = { action, reason: decision.reason, status: sub?.status ?? null };
  if (decision.kind === 'not_found') throw notFound(decision.message, 'SUBSCRIPTION_NOT_FOUND');
  if (decision.kind === 'validation') throw validationError(decision.message, details);
  throw conflict('INVALID_TRANSITION', decision.message, details);
}

// ---- reads -------------------------------------------------------------------------------------------------------

export async function listPlans(deps: Pick<BillingDeps, 'pool'>): Promise<PlanView[]> {
  return (await listPlanRows(deps.pool)).map(planView);
}

export async function getCurrentSubscription(deps: Pick<BillingDeps, 'pool' | 'clock'>, userId: string): Promise<SubscriptionView> {
  const row = await getOpenSubscription(deps.pool, userId);
  if (!row) throw notFound('No active subscription found', 'SUBSCRIPTION_NOT_FOUND');
  return buildView(deps.pool, row, deps.clock.now());
}

export interface HistoryEvent {
  id: string;
  subscriptionId: string;
  type: string;
  fromStatus: string | null;
  toStatus: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
}

export async function getHistory(deps: Pick<BillingDeps, 'pool'>, userId: string): Promise<HistoryEvent[]> {
  const { rows } = await deps.pool.query<{
    id: string;
    subscription_id: string;
    type: string;
    from_status: string | null;
    to_status: string | null;
    meta: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT e.id, e.subscription_id, e.type, e.from_status, e.to_status, e.meta, e.created_at
     FROM subscription_events e JOIN subscriptions s ON s.id = e.subscription_id
     WHERE s.user_id = $1 ORDER BY e.created_at, e.seq`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    subscriptionId: r.subscription_id,
    type: r.type,
    fromStatus: r.from_status,
    toStatus: r.to_status,
    meta: r.meta,
    createdAt: r.created_at.toISOString(),
  }));
}

export interface InvoiceView {
  id: string;
  subscriptionId: string;
  kind: string;
  status: string;
  amountCents: number;
  description: string;
  billingPeriodStart: string;
  createdAt: string;
}

export async function listInvoices(deps: Pick<BillingDeps, 'pool'>, userId: string): Promise<InvoiceView[]> {
  const { rows } = await deps.pool.query<{
    id: string;
    subscription_id: string;
    kind: string;
    status: string;
    amount_cents: number;
    description: string;
    billing_period_start: Date;
    created_at: Date;
  }>(
    `SELECT i.id, i.subscription_id, i.kind, i.status, i.amount_cents, i.description, i.billing_period_start, i.created_at
     FROM invoices i JOIN subscriptions s ON s.id = i.subscription_id
     WHERE s.user_id = $1 ORDER BY i.created_at DESC, i.id`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    subscriptionId: r.subscription_id,
    kind: r.kind,
    status: r.status,
    amountCents: r.amount_cents,
    description: r.description,
    billingPeriodStart: r.billing_period_start.toISOString(),
    createdAt: r.created_at.toISOString(),
  }));
}

// ---- simple (single-transaction) transitions ---------------------------------------------------------------------

/** Lock the caller's subscription, check the state machine, apply `change`, return the fresh view. All in ONE transaction. */
async function transition(
  deps: BillingDeps,
  userId: string,
  action: Action,
  change: (client: PoolClient, sub: SubscriptionRow, now: Date) => Promise<void>,
  guard?: (client: PoolClient, sub: SubscriptionRow) => Promise<void>,
): Promise<SubscriptionView> {
  return withTransaction(deps.pool, async (client) => {
    const sub = await lockOpenSubscription(client, userId);
    const now = deps.clock.now();
    assertAllowed(decide(action, snapshot(sub), now), action, sub);
    if (guard) await guard(client, sub!);
    await change(client, sub!, now);
    const { rows } = await client.query<SubscriptionRow>('SELECT * FROM subscriptions WHERE id = $1', [sub!.id]);
    return buildView(client, rows[0]!, now);
  });
}

export function pause(deps: BillingDeps, userId: string): Promise<SubscriptionView> {
  return transition(deps, userId, 'pause', async (client, sub, now) => {
    await client.query(`UPDATE subscriptions SET status = 'paused', paused_at = $2, updated_at = $2 WHERE id = $1`, [sub.id, now]);
    await insertEvent(client, { subscriptionId: sub.id, type: 'paused', fromStatus: 'active', toStatus: 'paused', meta: { paused_at: now.toISOString() }, at: now });
  });
}

export function resume(deps: BillingDeps, userId: string): Promise<SubscriptionView> {
  return transition(deps, userId, 'resume', async (client, sub, now) => {
    const pausedMs = Math.max(0, now.getTime() - sub.paused_at!.getTime());
    const newEnd = new Date(sub.current_period_end.getTime() + pausedMs);
    // status and paused_at change together so the paused_at-iff-paused CHECK always holds.
    await client.query(
      `UPDATE subscriptions SET status = 'active', paused_at = NULL, current_period_end = $2, updated_at = $3 WHERE id = $1`,
      [sub.id, newEnd, now],
    );
    await insertEvent(client, {
      subscriptionId: sub.id,
      type: 'resumed',
      fromStatus: 'paused',
      toStatus: 'active',
      meta: { paused_ms: pausedMs, previous_period_end: sub.current_period_end.toISOString(), new_period_end: newEnd.toISOString() },
      at: now,
    });
  });
}

export function cancel(deps: BillingDeps, userId: string, opts: { immediate: boolean }): Promise<SubscriptionView> {
  const action: Action = opts.immediate ? 'cancelImmediate' : 'cancel';
  return transition(deps, userId, action, async (client, sub, now) => {
    if (opts.immediate) {
      await client.query(
        `UPDATE subscriptions SET status = 'canceled', canceled_at = $2, cancel_reason = 'user_requested', cancel_requested_at = $2,
           pending_plan_id = NULL, past_due_since = NULL, next_retry_at = NULL, retry_count = 0, updated_at = $2
         WHERE id = $1`,
        [sub.id, now],
      );
      await insertEvent(client, {
        subscriptionId: sub.id,
        type: 'canceled',
        fromStatus: sub.status,
        toStatus: 'canceled',
        meta: { immediate: true, reason: 'user_requested', cleared_pending_plan_id: sub.pending_plan_id },
        at: now,
      });
      return;
    }
    if (sub.status === 'past_due') {
      // Stop retries but keep the full grace window: the job wakes at grace end and finalizes without charging.
      const grace = graceEndsAt(sub.past_due_since!);
      await client.query(
        `UPDATE subscriptions SET cancel_at_period_end = true, cancel_requested_at = $2, next_retry_at = $3, updated_at = $2 WHERE id = $1`,
        [sub.id, now, grace],
      );
      await insertEvent(client, {
        subscriptionId: sub.id,
        type: 'cancel_scheduled',
        fromStatus: 'past_due',
        toStatus: 'past_due',
        meta: { effective_at: grace.toISOString(), grace_ends_at: grace.toISOString() },
        at: now,
      });
      return;
    }
    await client.query(`UPDATE subscriptions SET cancel_at_period_end = true, cancel_requested_at = $2, updated_at = $2 WHERE id = $1`, [sub.id, now]);
    await insertEvent(client, {
      subscriptionId: sub.id,
      type: 'cancel_scheduled',
      fromStatus: sub.status,
      toStatus: sub.status,
      meta: { effective_at: sub.current_period_end.toISOString() },
      at: now,
    });
  });
}

export function reactivate(deps: BillingDeps, userId: string): Promise<SubscriptionView> {
  return transition(deps, userId, 'reactivate', async (client, sub, now) => {
    // In past_due, restore the retry schedule that cancellation had replaced (anchored to past_due_since).
    const nextRetry =
      sub.status === 'past_due' ? new Date(sub.past_due_since!.getTime() + Math.min(sub.retry_count + 1, 3) * DAY_MS) : null;
    await client.query(
      `UPDATE subscriptions SET cancel_at_period_end = false, cancel_requested_at = NULL,
         next_retry_at = CASE WHEN status = 'past_due' THEN $2::timestamptz ELSE next_retry_at END, updated_at = $3
       WHERE id = $1`,
      [sub.id, nextRetry, now],
    );
    await insertEvent(client, { subscriptionId: sub.id, type: 'reactivated', fromStatus: sub.status, toStatus: sub.status, meta: {}, at: now });
  });
}

export function removePendingChange(deps: BillingDeps, userId: string): Promise<SubscriptionView> {
  return transition(deps, userId, 'removePendingChange', async (client, sub, now) => {
    await client.query('UPDATE subscriptions SET pending_plan_id = NULL, updated_at = $2 WHERE id = $1', [sub.id, now]);
    await insertEvent(client, {
      subscriptionId: sub.id,
      type: 'downgrade_cleared',
      fromStatus: sub.status,
      toStatus: sub.status,
      meta: { reason: 'user_request', cleared_pending_plan_id: sub.pending_plan_id },
      at: now,
    });
  });
}

export function downgrade(deps: BillingDeps, userId: string, targetPlanId: string): Promise<SubscriptionView> {
  let target: PlanRow;
  return transition(
    deps,
    userId,
    'downgrade',
    async (client, sub, now) => {
      if (sub.pending_plan_id === target.id) return; // already scheduled: idempotent no-op
      await client.query('UPDATE subscriptions SET pending_plan_id = $2, updated_at = $3 WHERE id = $1', [sub.id, target.id, now]);
      await insertEvent(client, {
        subscriptionId: sub.id,
        type: 'downgrade_scheduled',
        fromStatus: sub.status,
        toStatus: sub.status,
        meta: {
          from_plan_id: sub.plan_id,
          to_plan_id: target.id,
          replaced_pending_plan_id: sub.pending_plan_id,
          effective_at: sub.current_period_end.toISOString(),
        },
        at: now,
      });
    },
    async (client, sub) => {
      const { current, to } = await loadPlanPair(client, sub, targetPlanId);
      if (to.interval !== current.interval) throw validationError('Plan changes between monthly and yearly billing are not supported', { reason: 'interval_mismatch' });
      if (to.price_cents >= current.price_cents) throw validationError('A downgrade must move to a cheaper plan', { reason: 'not_a_downgrade' });
      target = to;
    },
  );
}

async function loadPlanPair(q: Queryable, sub: SubscriptionRow, targetPlanId: string): Promise<{ current: PlanRow; to: PlanRow }> {
  const to = await getPlan(q, targetPlanId);
  if (!to) throw notFound('Plan not found', 'PLAN_NOT_FOUND');
  const current = (await getPlan(q, sub.plan_id))!;
  return { current, to };
}

// ---- upgrade -----------------------------------------------------------------------------------------------------

export interface UpgradePreview {
  fromPlan: PlanView;
  toPlan: PlanView;
  amountCents: number;
  chargeRequired: boolean;
  remainingMs: number;
  totalMs: number;
  periodStart: string;
  periodEnd: string;
  computedAt: string;
}

function planChecksForUpgrade(current: PlanRow, to: PlanRow): void {
  if (to.id === current.id) throw validationError('You are already on this plan', { reason: 'same_plan' });
  if (to.interval !== current.interval) throw validationError('Plan changes between monthly and yearly billing are not supported', { reason: 'interval_mismatch' });
  if (to.price_cents <= current.price_cents) throw validationError('An upgrade must move to a more expensive plan', { reason: 'not_an_upgrade' });
}

/** Read-only: what an upgrade would cost right now. Never charges. */
export async function upgradePreview(deps: BillingDeps, userId: string, targetPlanId: string): Promise<UpgradePreview> {
  const sub = await getOpenSubscription(deps.pool, userId);
  const now = deps.clock.now();
  assertAllowed(decide('upgrade', snapshot(sub), now), 'upgrade', sub);
  const { current, to } = await loadPlanPair(deps.pool, sub!, targetPlanId);
  planChecksForUpgrade(current, to);
  const pr = computeProration({
    oldPriceCents: current.price_cents,
    newPriceCents: to.price_cents,
    periodStart: sub!.current_period_start,
    periodEnd: sub!.current_period_end,
    now,
  });
  return {
    fromPlan: planView(current),
    toPlan: planView(to),
    amountCents: pr.amountCents,
    chargeRequired: pr.amountCents > 0,
    remainingMs: pr.remainingMs,
    totalMs: pr.totalMs,
    periodStart: sub!.current_period_start.toISOString(),
    periodEnd: sub!.current_period_end.toISOString(),
    computedAt: now.toISOString(),
  };
}

type ChargeRequest = Omit<ChargeInput, 'idempotencyKey'>;

type Collected = { phase: 'done'; view: SubscriptionView } | { phase: 'charge'; alloc: AllocateResult; chargeInput: ChargeRequest; obligationKey: string };

export async function upgrade(deps: BillingDeps, userId: string, targetPlanId: string): Promise<SubscriptionView> {
  // ---- Tx 1: lock, validate, compute, record the pending attempt, COMMIT ----
  const tx1 = await withTransaction<Collected>(deps.pool, async (client) => {
    const sub = await lockOpenSubscription(client, userId);
    const now = deps.clock.now();
    assertAllowed(decide('upgrade', snapshot(sub), now), 'upgrade', sub);
    const { current, to } = await loadPlanPair(client, sub!, targetPlanId);
    planChecksForUpgrade(current, to);

    const pr = computeProration({
      oldPriceCents: current.price_cents,
      newPriceCents: to.price_cents,
      periodStart: sub!.current_period_start,
      periodEnd: sub!.current_period_end,
      now,
    });
    const meta: UpgradeMeta = {
      kind: 'upgrade',
      fromPlanId: current.id,
      toPlanId: to.id,
      periodStart: sub!.current_period_start.toISOString(),
      periodEnd: sub!.current_period_end.toISOString(),
      amountCents: pr.amountCents,
      remainingMs: pr.remainingMs,
      totalMs: pr.totalMs,
      computedAt: now.toISOString(),
      description: `Upgrade from ${current.name} to ${to.name} (prorated)`,
    };

    if (pr.amountCents === 0) {
      // No provider call, no invoice (DECISIONS B2); the change is still audited.
      await writeUpgrade(client, sub!, meta, now, { invoiceId: null, operationId: null });
      const { rows } = await client.query<SubscriptionRow>('SELECT * FROM subscriptions WHERE id = $1', [sub!.id]);
      return { phase: 'done', view: await buildView(client, rows[0]!, now) };
    }

    // n distinguishes legitimately repeated upgrades between the same plans in one period.
    const prefix = `upgrade:${sub!.id}:${meta.periodStart}:${current.id}:${to.id}:`;
    const { rows: prior } = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM invoices WHERE kind = 'upgrade_proration' AND status IN ('paid', 'refunded') AND starts_with(obligation_key, $1)`,
      [prefix],
    );
    const obligationKey = `${prefix}${Number(prior[0]!.n) + 1}`;
    const alloc = await allocateChargeAttempt(client, {
      userId,
      subscriptionId: sub!.id,
      obligationKey,
      amountCents: pr.amountCents,
      meta: meta as unknown as Record<string, unknown>,
      now,
    });
    return {
      phase: 'charge',
      alloc,
      obligationKey,
      chargeInput: { amountCents: pr.amountCents, userId, subscriptionId: sub!.id, description: meta.description },
    };
  });

  if (tx1.phase === 'done') return tx1.view;
  return collect(deps, userId, tx1.alloc, tx1.obligationKey, tx1.chargeInput);
}

// ---- subscribe ---------------------------------------------------------------------------------------------------

export async function subscribe(deps: BillingDeps, userId: string, planId: string): Promise<SubscriptionView> {
  const tx1 = await withTransaction<Collected>(deps.pool, async (client) => {
    await lockUser(client, userId); // serialises concurrent subscribe/settle for this user
    const existing = await lockOpenSubscription(client, userId);
    const now = deps.clock.now();
    assertAllowed(decide('subscribe', snapshot(existing), now), 'subscribe', existing);
    const plan = await getPlan(client, planId);
    if (!plan) throw notFound('Plan not found', 'PLAN_NOT_FOUND');
    const periodStart = now;
    const periodEnd = addInterval(now, plan.interval);

    if (plan.price_cents === 0) {
      const { rows } = await client.query<SubscriptionRow>(
        `INSERT INTO subscriptions (user_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at)
         VALUES ($1, $2, 'active', $3, $4, $3, $3) RETURNING *`,
        [userId, plan.id, periodStart, periodEnd],
      );
      await insertEvent(client, {
        subscriptionId: rows[0]!.id,
        type: 'subscribed',
        fromStatus: null,
        toStatus: 'active',
        meta: { plan_id: plan.id, amount_cents: 0, period_start: periodStart.toISOString(), period_end: periodEnd.toISOString() },
        at: now,
      });
      return { phase: 'done', view: await buildView(client, rows[0]!, now) };
    }

    const { rows: count } = await client.query<{ n: string }>('SELECT count(*) AS n FROM subscriptions WHERE user_id = $1', [userId]);
    const obligationKey = `initial:${userId}:${Number(count[0]!.n) + 1}`;
    const meta: InitialMeta = {
      kind: 'initial',
      planId: plan.id,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      description: `${plan.name} subscription`,
    };
    const alloc = await allocateChargeAttempt(client, {
      userId,
      subscriptionId: null,
      obligationKey,
      amountCents: plan.price_cents,
      meta: meta as unknown as Record<string, unknown>,
      now,
    });
    return { phase: 'charge', alloc, obligationKey, chargeInput: { amountCents: plan.price_cents, userId, subscriptionId: null, description: meta.description } };
  });

  if (tx1.phase === 'done') return tx1.view;
  return collect(deps, userId, tx1.alloc, tx1.obligationKey, tx1.chargeInput);
}

// ---- phases 2 and 3 shared by subscribe and upgrade --------------------------------------------------------------

async function collect(
  deps: BillingDeps,
  userId: string,
  alloc: AllocateResult,
  ownObligationKey: string,
  chargeInput: ChargeRequest,
): Promise<SubscriptionView> {
  switch (alloc.kind) {
    case 'already_succeeded':
      // The obligation was already collected and applied: an idempotent repeat.
      return getCurrentSubscription(deps, userId);

    case 'created': {
      // Phase 2: NO transaction is open here.
      const outcome = await callProvider(deps, { ...chargeInput, idempotencyKey: alloc.op.idempotency_key });
      // Unknown outcome: the attempt stays pending. It is resolved by reconciliation or by a retry that finds it
      // (same key, lookup first). We NEVER respond by creating a new attempt.
      if (outcome.type === 'unknown') throw inProgress(alloc.op);
      return finish(deps, userId, await settleCharge(deps, alloc.op.id, outcome));
    }

    case 'pending': {
      // A previous attempt never reached its outcome (crash / timeout / lost response). Resolve THAT attempt.
      let found;
      try {
        found = await deps.provider.lookup(alloc.op.idempotency_key);
      } catch {
        throw inProgress(alloc.op);
      }
      if (!found) throw inProgress(alloc.op); // still in flight, or not yet resolvable: the reconciler decides
      const settled = await settleCharge(
        deps,
        alloc.op.id,
        found.status === 'succeeded'
          ? { type: 'succeeded', providerReference: found.providerReference ?? '' }
          : { type: 'failed', errorCode: found.errorCode ?? 'declined', message: found.message ?? 'Declined by provider' },
      );
      if (alloc.op.obligation_key !== ownObligationKey) {
        // We just finalized someone else's earlier payment; the caller must look at the new state and decide again.
        throw conflict('OPERATION_IN_PROGRESS', 'A previous payment was just finalized. Please review your subscription and retry if needed.');
      }
      return finish(deps, userId, settled);
    }
  }
}

function inProgress(op: OperationRow): AppError {
  return conflict('OPERATION_IN_PROGRESS', 'Your payment is still being confirmed. Please retry shortly; you will not be charged twice.', { operationId: op.id });
}

async function finish(deps: BillingDeps, userId: string, result: SettleResult): Promise<SubscriptionView> {
  switch (result.status) {
    case 'applied':
      return getCurrentSubscription(deps, userId);
    case 'declined':
      throw new AppError(402, 'PAYMENT_FAILED', 'Your payment was declined. Nothing was changed; you can try again.', { operationId: result.op.id });
    case 'discarded':
      // Compensation was recorded durably in Tx 2; run the refund now, outside any transaction. The reconciler also retries it.
      try {
        await processRefund(deps, result.refundOperationId);
      } catch {
        /* recovered by the reconciliation job */
      }
      throw conflict('STATE_CHANGED', 'Your subscription changed while the payment was processing. The charge will be refunded.', { operationId: result.op.id });
    case 'already_settled': {
      const op = await getOperation(deps.pool, result.op.id);
      if (op?.status === 'failed') throw new AppError(402, 'PAYMENT_FAILED', 'Your payment was declined. Nothing was changed; you can try again.', { operationId: result.op.id });
      if (result.applied) return getCurrentSubscription(deps, userId);
      throw conflict('STATE_CHANGED', 'Your subscription changed while the payment was processing. The charge will be refunded.', { operationId: result.op.id });
    }
  }
}

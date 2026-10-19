# SubCycle — Decisions

Status: **Approved with revisions (Stage 0 → Stage 1).** Section A is fixed by the spec. Section B holds the assumptions, as revised after review. See the revision log (§E) for what changed.

## A. Fixed decisions (from SPEC §4)

| Topic | Decision |
|---|---|
| Currency | INR. All amounts are integers in paise. (Column names use `_cents` per spec; the unit is paise.) |
| Time | Store everything in UTC (`timestamptz`). No local-time logic. |
| Clock | All time comes from an injected `Clock` interface (`now()`), never a bare `new Date()` in business logic. Tests use a fake clock. |
| Free plan | Same lifecycle as paid plans, price 0. No billing-provider calls for zero amounts. Renewal of a free plan just rolls the period and writes an event. |
| Trials | Not in v1. `trialing` is not in the status enum. |
| One subscription per user | At most one non-canceled subscription per user (partial unique index). Canceled history is kept. |
| Interval changes | Upgrade/downgrade between different intervals (month <-> year) is rejected with a validation error (400). |
| Grace period | `past_due` keeps access for 3 days from the first failed renewal, then access is blocked. Same rule in API, usage middleware, frontend, and tests. |
| Retry policy | A failed renewal is retried once per day, max 3 retries. After that (or when the grace period ends, whichever is first) the subscription is canceled with reason `payment_failed`. |
| Pending downgrade + pause | A pending downgrade survives a pause. |
| Replacing/removing pending downgrade | Requesting another downgrade replaces it. `DELETE /subscriptions/pending-change` removes it. |
| Cancel while paused | Rejected with 409. User must resume first. |
| Cancel + pending downgrade | Cancellation wins at period end; pending plan is cleared on finalization. |
| Rounding | Round half up to the nearest paise, applied once, on the final prorated amount. |

## B. Additional assumptions

### B1. Grace period and retry schedule (revised)
- **Grace start** (`past_due_since`) = the `Clock.now()` value recorded in the transaction that records the *first failed renewal attempt* (the job's Tx 2). It is **not** `current_period_end` (the job may run late). It is set once and never moved by later retries.
- `grace_ends_at = past_due_since + 72 hours` (exact).
- **Access rule** (single pure function `hasAccess`): `past_due` has access iff `now < grace_ends_at`. At exactly `now == grace_ends_at` access is **blocked**.
- **Retry schedule** is anchored to `past_due_since`, not to when a retry actually ran: retry *n* is due at `past_due_since + n days`, n = 1, 2, 3. `next_retry_at` always holds the due time of the next retry. Retry 3 is due exactly at `grace_ends_at`.
- **Retry at exactly 72h**: the retry is still *run* by the job (the job selects `next_retry_at <= now`), even though read-path access is already blocked at that instant. If it succeeds, the subscription returns to `active` and access is restored; if it fails, the subscription is canceled (`payment_failed`). So "grace ends" blocks usage, it does not forbid the final collection attempt.
- **Job lag**: if the job visits a `past_due` subscription at `now >= grace_ends_at` with retries remaining (intermediate retries were missed), it makes **one final attempt** (counted as the final retry); success → `active`, failure → canceled (`payment_failed`). Missed intermediate retries are not replayed, and no subscription is canceled without at least one attempt after the initial failure.
- `retry_count` counts failed retries (the initial failed renewal is not a retry); it never exceeds 3 (CHECK). Reset to 0, and `past_due_since` / `next_retry_at` cleared, on recovery.

### B2. Zero-value changes: no invoice, but always audited
- No invoice rows are written for zero-amount operations (free renewals, free subscribes, upgrades whose prorated amount rounds to 0). Enforced by `CHECK (amount_cents > 0)` on `invoices`.
- The plan change is **always** recorded in `subscription_events` (`meta.amount_cents = 0`, old/new plan, period boundaries), in the same transaction as the state change.
- Consequence: the `initial` invoice kind is used only for paid first subscriptions.

### B3. Period arithmetic
- "One interval" = one calendar month or year added in **UTC** (not 30/365 days). Day-of-month is clamped to the last day of the target month (e.g. Jan 31 + 1 month = Feb 28, or Feb 29 in a leap year).
- Renewal rolls from the **old `current_period_end`**, never from `now`. Known limitation: repeated clamping can drift the anchor day (Jan 31 → Feb 28 → Mar 28). Accepted for v1.
- If the job was down for several periods it rolls one period per visit and charges each separately. Documented limitation.
- `current_period_end > current_period_start` is enforced by CHECK.

### B3a. Pause / resume details
- Pause: `status=paused`, `paused_at=now`. Period fields unchanged; renewals skip paused subscriptions.
- Resume: `current_period_end += (now - paused_at)`; `current_period_start` unchanged (so the usage period stays the same and usage "freezes"). `paused_at` cleared, status `active`. Resume never charges.
- Pausing is allowed when `cancel_at_period_end = true`; the flag survives. Reactivate from `paused` is rejected (409) — resume first.
- **Interaction matrix** (every row satisfies the `paused_at`-iff-`paused` CHECK because `status` and `paused_at` are always written in the same UPDATE):

| Transition | `status` | `paused_at` | other fields |
|---|---|---|---|
| Pause (from `active`) | `paused` | `= now` | `cancel_at_period_end`, `cancel_requested_at`, `pending_plan_id`, period dates untouched |
| Resume | `active` | `NULL` | `current_period_end += now - paused_at`; flags untouched (a scheduled cancel now takes effect at the *extended* end) |
| Downgrade / remove pending change while paused | `paused` | unchanged | only `pending_plan_id` changes |
| Cancel while paused | rejected 409 | — | — |
| Renewal job on a paused row | never selected (`status = 'active'` only) | — | — |
| Pause from `past_due` | rejected 409 | — | — |
- Never allowed: a row with `paused_at` set and status other than `paused`, or `paused` with `paused_at` NULL; the CHECK makes such an application bug fail loudly.

### B4. Plan-change validation
- **Upgrade**: target differs from current, same `interval`, **strictly higher** `price_cents`. Otherwise 400 (`VALIDATION_ERROR`), or 409 for wrong state.
- **Downgrade**: same `interval`, **strictly lower** `price_cents` than the *current* plan.
- Upgrade while `cancel_at_period_end = true`: allowed; flag kept.
- Upgrade while a pending downgrade exists: allowed; the pending downgrade is **cleared in the same transaction** as the plan switch, and the `upgraded` event's `meta` records the cleared plan (`cleared_pending_plan_id`), in addition to a `downgrade_cleared` event.
- Downgrade while `cancel_at_period_end = true`: allowed (stored); cleared at finalization per fixed decision.

### B5. Cancel from `past_due` (REVISED in review of Stage 1 — grace is preserved)
The 72-hour grace period is an explicit promise: a cancellation request **stops future renewal attempts but never shortens the grace period**.
- **Default cancel** (`POST /subscriptions/cancel`) in `past_due`: sets `cancel_at_period_end = true` and `cancel_requested_at = now`, **sets `next_retry_at = grace_ends_at`** (the job's wake-up time for this row), keeps `retry_count` as is, and writes `cancel_scheduled` (meta: `grace_ends_at`). Status stays `past_due`. Access continues under the B1 rule until `grace_ends_at`.
- **Job behaviour.** A `past_due` row is selected by `status = 'past_due' AND next_retry_at <= now` (unchanged query). On visit it branches on `cancel_at_period_end`:
  - flag **set** → **no charge is attempted** (the pending retries are abandoned because `next_retry_at` was moved to `grace_ends_at`); finalize `status = canceled`, `canceled_at = now`, `cancel_reason = user_requested`, `pending_plan_id = NULL`, `next_retry_at = NULL`, event `canceled`;
  - flag **clear** → ordinary retry (B1).
- **Terminal boundary** = `grace_ends_at` (= `past_due_since + 72h`). It is the applicable boundary for a delinquent subscription because its paid period already ended; the grace window is the only access that remains. The cancel is finalized by the job's first visit at or after that instant (job lag can delay *finalization* but access is already blocked from `grace_ends_at` by the access rule, so lag never extends access).
- **Immediate cancellation (explicit opt-in)**: `POST /subscriptions/cancel` with body `{ "immediate": true }` while `past_due` cancels at once: `status = canceled`, `canceled_at = now`, `cancel_reason = user_requested`, retry fields cleared, `cancel_at_period_end` left `false`, `cancel_requested_at = now`, event `canceled` (meta: `immediate: true`). Access ends immediately. `immediate` is rejected (400) for any other state.
- **Distinguishing from ordinary retries**: a user-requested cancel in `past_due` is recognizable by `cancel_at_period_end = true` (and `cancel_requested_at`), and the final `cancel_reason = user_requested` differs from `payment_failed` (retries exhausted). A user cancel followed by `payment_failed` is impossible because retries don't run once the flag is set.
- **Reactivate** (B6) is allowed in `past_due` with the flag set until finalization: it clears the flag and `cancel_requested_at` and restores the retry schedule: `next_retry_at = past_due_since + (retry_count + 1) days` (if that instant is already past, it is due immediately; the final-attempt rule in B1 applies).
- `cancel_reason` values: `user_requested`, `payment_failed` (CHECK). `cancel_requested_at` records when the user asked. **No schema change is needed**: every timestamp above is representable with existing columns, and the existing CHECKs (`next_retry_at` only when `past_due`; `cancel_at_period_end` implies `cancel_requested_at`; canceled fields set iff `canceled`) all hold for each path.

### B6. Reactivate
- Allowed when (`status = active`, `cancel_at_period_end = true`, `now < current_period_end`) **or** (`status = past_due`, `cancel_at_period_end = true`, not yet finalized; see B5). Clears both `cancel_at_period_end` and `cancel_requested_at`. Otherwise 409.

### B7. Idempotency — provider layer and HTTP layer

**Provider layer (billing_operations).** Two identifiers, deliberately distinct:
- **`obligation_key`** — identifies the *logical billing obligation* ("charge this user X for this thing"). Stable across retries. Format, generated in the service:
  - `renewal:{subscription_id}:{billing_period_start_iso}`
  - `upgrade:{subscription_id}:{period_start_iso}:{from_plan_id}:{to_plan_id}:{n}` where `n` = 1 + number of *paid* upgrade invoices already issued for the same subscription / period / from / to (so even a legitimate repeat of the same plan pair in one period is a different obligation)
  - `initial:{user_id}:{n}` where `n` = 1 + number of subscriptions the user already has (including canceled)
- **`idempotency_key`** — identifies one *payment attempt* of an obligation: `charge:{obligation_key}:attempt:{n}`. Unique in the DB. `UNIQUE (obligation_key, operation_type, attempt)` as well.
- **Rules**
  1. Concurrent or repeated requests for the same obligation reuse the **same** attempt (and so the same key) while the attempt is `pending` or `succeeded`: a partial unique index allows at most one `pending` charge per `obligation_key`; a second request gets 409 `OPERATION_IN_PROGRESS`.
  2. A **new attempt number (new key) is created only after the previous attempt is definitively `failed`**.
  3. **Unknown outcome** (timeout, crash, lost response): the operation stays `pending`. It is **never** answered with a fresh key. Reconciliation resolves the *existing* attempt via `provider.lookup(idempotency_key)`. Only a definitive provider answer moves it to `succeeded` / `failed`. For a lookup "not found": the mock provider is authoritative and the operation becomes `failed`; a real provider integration must treat "not found" as definitive only if its idempotency window guarantees a late charge can't appear (otherwise keep retrying the *same* key, don't mint a new one).
  4. `billing_operations.subscription_id` is nullable and `user_id` is mandatory (see B9). The operation is linked to the new subscription in the same Tx 2 that creates it.

**HTTP layer (`idempotency_keys` table).** Protects API retries separately from provider idempotency.
- Columns: authenticated `user_id`, client `key`, `request_method`, `request_path`, `request_hash` (SHA-256 of the canonicalised body + method + path), `status` (`in_progress` | `completed`), `locked_until`, `response_status`, `response_body` (replayable JSON), timestamps, `expires_at`. `UNIQUE (user_id, key)`.
- Flow: insert `in_progress` with `locked_until = now + 60s`. Completed → replay stored status/body with an `Idempotent-Replay: true` header. Only 2xx and 4xx responses are stored; a 5xx / unexpected error deletes the row so the client can retry.
- **Different request, same key** (hash mismatch) → 422 `IDEMPOTENCY_KEY_REUSED`.
- **Same request while in progress** and lock not expired → 409 `REQUEST_IN_PROGRESS`.
- **Abandoned requests** (process died; `in_progress` and `locked_until < now`): the next request with the same key and hash **takes over** the row (extends `locked_until`) and re-runs the handler. This is safe because every charge inside is itself idempotent through `obligation_key` / attempt rules above — the re-run finds the existing operation instead of charging again.
- Rows expire after 24 h (`expires_at`) and are purged opportunistically.

### B7a. Stage 3/4 implementation notes (billing layer + subscription service)
- **One in-flight charge per subscription** (not just per obligation): a pending charge on a subscription blocks any new charge for it (for an initial subscribe: per user). This also stops two simultaneous upgrades to *different* plans from both being charged.
- **Succeeded-but-discarded attempts don't count as collected**: if a charge succeeded but its effect was discarded and refunded (B12), the obligation may be attempted again with the next attempt number.
- **Declined payment** → HTTP 402 `PAYMENT_FAILED` (state unchanged); **unknown outcome / in-flight** → 409 `OPERATION_IN_PROGRESS`; **state changed during the charge** → 409 `STATE_CHANGED` (the charge is refunded). Failed upgrades keep a `failed` invoice; failed initial subscribes have no invoice (no subscription yet) and no failure event (the operation row is the record).
- **HTTP idempotency storage rules**: 2xx and deterministic 4xx (including 402 `PAYMENT_FAILED`, so a new attempt needs a new key) are stored and replayed; 5xx and the transient codes `OPERATION_IN_PROGRESS`, `REQUEST_IN_PROGRESS`, `RATE_LIMITED` are **not** stored, so the same key can be retried and resumes the work.
- **Event ordering**: migration `0005_event_sequence.sql` adds `subscription_events.seq` (identity). Events written by one transaction share a timestamp from the `Clock`; history orders by `(created_at, seq)`.
- Operation rows' `created_at` / `updated_at` are set from the application `Clock` (not DB `now()`), so reconciliation age checks agree with the injected time in tests.
- Lifecycle changes that do not charge (pause, resume, cancel, reactivate, downgrade, pending-change removal, zero-amount upgrade, free subscribe) run in a **single** transaction with their audit event.
- `StripeProvider` is an unimplemented stub documenting the integration contract; `BillingProvider.charge` takes `userId` and a nullable `subscriptionId` (initial charges have no subscription yet).

### B8. Invoices — identity of a logical billing obligation (revised)
- One invoice per **billing obligation**, identified by `invoices.obligation_key` (same string as `billing_operations.obligation_key`; globally `UNIQUE`). The invoice row is created in the Tx 2 of the first attempt outcome and **updated** (`failed` → `paid`) when a later attempt succeeds. Per-attempt history lives in `billing_operations`.
- `plan_id` (plan being billed) is stored for display/reporting only; it is **not** part of any unique key.
- Additional **renewal-period key**: `UNIQUE (subscription_id, billing_period_start) WHERE kind = 'renewal'`, so a subscription's renewal for a given period can exist once, independently of the obligation key's format.
- `billing_period_start`: for `renewal`, the start of the period *being paid for* (= the old `current_period_end`); for `initial` and `upgrade_proration`, the `current_period_start` of the period in which it happens.
- Failed invoices are kept for audit (they're only ever updated to `paid`, never deleted).
- The spec's `UNIQUE (subscription_id, kind, billing_period_start)` is **replaced** by the above (approved).

### B9. Subscribe flow
- Paid plan, Tx 1: verify no non-canceled subscription; insert `billing_operations(status=pending, user_id, subscription_id=NULL, obligation_key=initial:{user}:{n})` and record the intended `period_start` in the operation's `meta` so Tx 2 uses the same `now`. No transaction during the charge.
- Tx 2: re-check no active subscription exists; create the subscription, set `billing_operations.subscription_id` and `invoice_id`, create the paid `initial` invoice, write `subscribed`. If a subscription appeared meanwhile, or the plan is gone, follow B12 (record refund requirement, 409).
- Charge failed: no subscription, no invoice (an invoice requires a subscription); the failure lives only in `billing_operations`.
- Free plan: single transaction; no operation, no provider call.

### B10. Refunds and compensation (revised)
- `refund` operations exist for compensation (B12), not for a user-facing refund flow. Invoice status `refunded` is set only by a completed compensation of a previously **paid** invoice.
- A refund is a `billing_operations` row with `operation_type = 'refund'`, `refund_of_operation_id` → the charge, idempotency key `refund:{obligation_key}:attempt:{n}`, `UNIQUE (refund_of_operation_id)`.
- **The provider refund call is never made inside a database transaction.**

### B11. Reconciliation
- Operations `pending` for more than `RECONCILE_AFTER_MINUTES` (default 5) are resolved via `provider.lookup(idempotency_key)` per B7 rule 3. **Implemented in Stage 3/4** as `reconcilePendingOperations` (`services/reconciliationService.ts`); cron wiring comes with the jobs stage. Because the provider lookup happens outside any transaction, the reconciler lists candidates without locks and the *claim* happens in `settleCharge`, which locks the parent row and then the operation (consistent order: subscription/user, then operation) and re-checks `status = 'pending'`. This gives the same exclusion as `SKIP LOCKED` (a concurrent reconciler or user retry finds the operation already settled and does nothing) without holding a transaction across a network call.
- A user **retry** that finds a pending attempt for the same subscription also resolves it first (lookup, then settle); it never creates a new attempt while one is unresolved. A provider call slower than `BILLING_TIMEOUT_MS` is treated as an unknown outcome, never as a failure.
- Both pending **charges** and pending **refunds** are processed by this job. `billing_operations.resolve_attempts` and `last_checked_at` support back-off and alerting.

### B12. Tx 2 revalidation and compensation (revised)
If on Tx 2 the charge succeeded but the subscription no longer matches the expected state (paused/canceled concurrently, plan changed, a second subscription appeared, …):
1. In **one transaction**: mark the charge operation `succeeded`; insert a `pending` **refund operation** (reason `state_changed`) — this is the durable "compensation required" record; write a `charge_discarded` event with the details. **No provider call, no plan change.** Commit.
2. **After commit**, outside any transaction, a refund processor (invoked inline right after the commit and again by the reconciliation job) calls `provider.refund` with the refund operation's idempotency key, then records the outcome (`succeeded` / `failed`; a failed refund stays visible and is retried with the same key unless definitively failed).
3. The user receives 409. Money is therefore never kept silently, and a crash between steps 1 and 2 is recovered by the job.

### B12a. Transactional outbox / future Stripe (architecture note)
A mock provider can't prove exactly-once effects across a DB and an external payment system. Stage 1's schema supports the production-grade pattern without implementing all of it:
- durable operation rows with explicit states, written *before* the provider call (outbox-equivalent: `billing_operations`, including pending refunds);
- provider-level idempotency keys per attempt;
- reconciliation of unknown outcomes by lookup, never by minting a new key;
- `resolve_attempts` / `last_checked_at` columns for the recovery worker;
- a nullable `meta` JSONB on operations for provider payload references.
A future `StripeProvider` also needs webhook ingestion (provider events de-duplicated by event id) — out of scope for v1 and not in the schema yet.

### B12b. Invoice status vs. billing-operation consistency
- `invoices.amount_cents > 0` stays (zero-amount changes never create invoices, B2).
- An invoice and its operations are always changed in the **same transaction**, so they cannot disagree:
  - `paid` ⇔ the obligation has a `succeeded` charge operation (and `invoice_id` points to the invoice);
  - `failed` ⇔ the obligation has at least one `failed` charge operation and **no** `succeeded` one; a later `succeeded` attempt flips it to `paid`;
  - `refunded` ⇔ a `succeeded` refund operation whose `refund_of_operation_id` is the invoice's succeeded charge. A **pending** refund leaves the invoice `paid`; a failed refund also leaves it `paid` and stays visible for retry/alerting.
- Compensation refunds for a charge that never produced an invoice (B12, e.g. initial subscribe race) have no invoice to mark; the refund operation row is the record.
- These rules are covered by service tests in the stages that implement them (Stage 3/4); the schema already forbids dangling links (FKs) and duplicate refunds.

### B13. Usage metrics
- See B13a for the complete usage accounting and policy rules (valid metrics, `0`, `null`/unlimited, quantities).
- Usage is recorded against the subscription's **actual stored** `current_period_start`; the free plan tracks usage too. Limits are tied to the real billing period (monthly or yearly per plan interval, never a hard-coded calendar month). Yearly plan limits (e.g. Pro Yearly `api_calls` = 60,000) are a documented product decision: a yearly subscriber gets 12× the monthly allowance over the year.
- On plan change mid-period usage carries over; new limits apply immediately for upgrades.
- Access: see B19 (strict period boundary; `past_due` per B1; `paused` / `canceled` / none → 402).

### B13a. Usage accounting semantics (designed BEFORE implementing enforcement)

**Principle: usage is consumed if and only if the metered operation commits.** Never "increment, then let the request fail".

1. **Atomic check-and-increment.** One conditional statement against PostgreSQL:
   `INSERT INTO usage_records ... ON CONFLICT (subscription_id, metric, period_start) DO UPDATE SET quantity = usage_records.quantity + EXCLUDED.quantity WHERE <unlimited> OR usage_records.quantity + EXCLUDED.quantity <= :limit RETURNING quantity`.
   The INSERT branch is guarded the same way (`WHERE :qty <= :limit`). No row returned = limit exceeded. PostgreSQL row-locks the counter on conflict and re-evaluates the `WHERE` against the latest committed value, so there is no read-then-write race; the limit holds under any concurrency. All-or-nothing: a request that does not fully fit consumes nothing (no partial consumption).
2. **Subscription state is locked in the same transaction.** The check runs in one short transaction that first takes `SELECT … FROM subscriptions … FOR SHARE` on the caller's open subscription. Lifecycle changes use `FOR UPDATE`, so pause/cancel/upgrade/renewal and usage are serialized: usage can never be recorded for a subscription after a pause has committed ("pause freezes usage"), and limits are always evaluated against the plan that is current at that instant.
3. **Metered DB work commits atomically with its usage (demo endpoint, `enforceLimit`).** `enforceLimit` opens a transaction, takes the share lock, consumes usage, and hands the transaction client to the handler (`req.meter.client`). The handler's own writes use that same client. The transaction is **finalized before the response is sent**: COMMIT if the response status is < 400, ROLLBACK otherwise. Consequences:
   - rejected requests (402 / 429 / 400 / 401) consume nothing;
   - handler errors or any ≥ 400 response roll the increment back;
   - if COMMIT itself fails, the client receives **500** (never a success body) and nothing is consumed or persisted;
   - a client that disconnects mid-request gets its transaction rolled back.
4. **Real external work (cannot join the DB transaction).** If the work succeeds but the database commit fails there is no atomicity, so v1 documents (and `POST /usage` supports) this recommended protocol:
   - **record-after-success** (default): do the external work with its own idempotency key, then `POST /usage` with `Idempotency-Key: <same request id>`. If the commit fails the caller retries the *same* key and usage is recorded **exactly once** (below). If the caller dies after the work but before recording, usage is **under-counted** (fail-open in the customer's favour). Limits are not enforced *before* the work in this mode.
   - **reserve-first** (when the limit must hold before expensive work): `POST /usage` first, then do the work. If the work then fails, usage stays consumed (over-count, fail-closed). v1 has no negative adjustments/refunds of usage (`quantity > 0`); crediting back is a future feature.
   - Choose per metric; the demo endpoint is the transactional case in (3).
5. **Exactly-once recording via a ledger.** Every consumption writes a row to `usage_events` in the **same transaction** as the counter update. `POST /usage` accepts an optional `Idempotency-Key`; it is stored as `usage_events.request_key` with a partial unique index `(subscription_id, request_key)`. A retry with the same key inserts nothing, increments nothing and returns the original outcome with `replayed: true`; the same key with a different metric/quantity is `422 IDEMPOTENCY_KEY_REUSED`. Because the dedupe record and the counter change commit together, a crash can never leave one without the other (this is why `/usage` uses the ledger instead of the generic HTTP `Idempotency-Key` middleware, whose bookkeeping is a separate transaction). Invariant (tested): for every counter, `SUM(usage_events.quantity)` equals `usage_records.quantity`.
6. **Concurrent same-key requests**: the second blocks on the unique index until the first commits or rolls back; if it committed the second is a replay, if it rolled back (e.g. 429) the second proceeds normally.

**Policy for metrics and quantities**
- **Valid metrics** are the keys of the *current plan's* `limits`. A metric not in `limits` → `400 UNKNOWN_METRIC` (it is not tracked on this plan; "missing" never means "unlimited"). Metric names match `^[a-z][a-z0-9_]{0,62}$`.
- **Limit values**: a non-negative integer = cap; **`0` = not allowed** (always 429); **JSON `null` = unlimited** (never 429; counted for reporting); any other value (string, negative, fraction, boolean) is treated as **malformed and denies** (behaves as 0) rather than silently granting unlimited use.
- **Quantity**: integer, `1 ≤ quantity ≤ 1,000,000`, strict JSON number (no strings, decimals, zero, negatives, null). Default quantity for `enforceLimit` is 1.
- **Period scoping**: usage is keyed by the subscription's *stored* `current_period_start`. A renewal (new `current_period_start`) naturally starts fresh counters; old rows are kept. Pause/resume keep the same period (resume only moves `current_period_end`). An upgrade mid-period keeps the counters and applies the new plan's limits immediately; a scheduled downgrade has no effect until the period rolls. `GET /usage` lists the metrics of the current plan (counters for metrics that left the plan are not shown).
- **Access policy** (single function `hasAccess`): `active` ✓ (also with `cancel_at_period_end`); `past_due` ✓ strictly before `past_due_since + 72h`, ✗ from that instant; `paused` ✗; `canceled`/no subscription ✗. `POST /usage` and the demo endpoint return **402**: `SUBSCRIPTION_REQUIRED` (no open subscription) or `SUBSCRIPTION_INACTIVE` (paused / grace expired, with `details.status` and `details.graceEndsAt`). `GET /usage` is read-only and works whenever an open subscription exists (including paused, so users can see their usage; it reports `accessAllowed`); with no open subscription it is `404 SUBSCRIPTION_NOT_FOUND`.
- **Limit exceeded**: `429 LIMIT_EXCEEDED`, `details: { metric, limit, used, remaining, requested, periodEnd }`. Distinct from the rate limiter's `429 RATE_LIMITED`.
- **Rate limiting**: `/usage` and `/demo/*` have a per-user limiter (default 600 requests / minute, `USAGE_RATE_LIMIT_MAX`, `USAGE_RATE_LIMIT_WINDOW_MS`).
- **Stale period**: superseded by B19. An `active` subscription gets no usage access from `current_period_end` onward.
- **Schema**: migration `0006` adds `usage_events` (ledger) and `demo_reports` (the demo's metered work, each report referencing exactly one usage event).

### B19. Period boundary, renewal and reconciliation jobs (Stage 6)

**The period boundary is strict and shared.** One function, `hasAccess(sub, now)`, is used by the subscription views, `GET/POST /usage`, `enforceLimit` and the renewal job. It supersedes the "stale period" limitation of B13.
- `active`: access iff `now < current_period_end`. **At exactly `current_period_end`, access stops**, whether or not the renewal job has run. Usage is refused with `402 SUBSCRIPTION_INACTIVE` (`details.reason = "period_ended"`, `periodEnd`). The job restores access (new period) or moves the subscription to `past_due` / `canceled`.
- The job treats a subscription as due when `current_period_end <= now` (the **same inclusive instant**). There is no instant at which a subscription is both "not yet due" and "without access", or "due" and "with access".
- Lifecycle consistency at the boundary: `upgrade` and `pause` are refused (409 `renewal_due`) once an `active` period has ended (an upgrade would otherwise be prorated to 0 for a lapsed period, and a pause would grant free time). `cancel`, `downgrade` and removing a pending change still work; `reactivate` is refused (already existed).
- **Known, accepted consequence**: if the job is late, the user is blocked from `period_end` until the job runs; if the renewal then *fails*, grace access (72 h) starts at the failure time (B1, unchanged). Run the job every minute to keep that window small.

**Job structure** (`services/renewalService.ts`, cron in `jobs/`): each cycle = (1) reconcile pending operations and process pending refunds, then (2) renew due subscriptions. A subscription is processed in its own transaction(s), so one failure does not block the batch.
- **Due selection**: `status = 'active' AND current_period_end <= now` (renewal) or `status = 'past_due' AND next_retry_at <= now` (retry / finalize). Paused and canceled rows are never due.
- **Claiming**: `SELECT … FOR UPDATE SKIP LOCKED` on the subscription row in Tx 1. A row locked by another worker or a user action is skipped, not waited on. Due-ness is re-validated under the lock, so a second run finds nothing to do.
- **Order of operations for one due subscription** (cancellation wins over everything): (a) `cancel_at_period_end` → finalize the cancellation (`user_requested`, pending plan cleared, **no charge**); (b) otherwise the next plan = `pending_plan_id` if set else the current plan; (c) price 0 → roll the period, apply the pending plan, no provider call, no invoice; (d) otherwise two-phase charge, then on success roll the period, apply the pending plan, mark/create the paid invoice, write `renewed` (+ `downgrade_applied`).
- **Roll rule**: `new_start = old current_period_end`, `new_end = addInterval(old_end)`; never from `now`. One period per visit; a long outage is caught up one period per run, each period charged and invoiced once (unique obligation + renewal-period index).
- **Obligation / attempts**: `renewal:{subscription_id}:{old_period_end ISO}`; failed attempts get `attempt:{n+1}` only after a definitive failure; an unresolved (`pending`) attempt blocks a new one and is resolved by lookup of its original key (B7).
- **Failure handling** (inside the Tx 2 that records the failed attempt):
  - from `active` (first failure): failed invoice kept, `status = past_due`, `past_due_since = now`, `retry_count = 0`, `next_retry_at = past_due_since + 1 day`, period **not** extended, event `renewal_failed`;
  - from `past_due` (retry): `retry_count += 1`; **cancel with `payment_failed`** if `retry_count >= 3` **or** `now >= past_due_since + 72 h` (so the retry due exactly at the grace end is attempted and, if it fails, ends the subscription; a late job gets its one final attempt first); else `next_retry_at = past_due_since + (retry_count + 1) days` (anchored, never drifting). Events: `renewal_failed` (+ `canceled`).
  - a recovered retry returns to `active` (period rolled from the old end, retry fields cleared, same invoice flips `failed → paid`).
  - **Not a payment failure**: an attempt the reconciler proves never reached the provider (`not_found_at_provider`) marks the operation failed but changes neither the subscription nor creates a failed invoice; the next run simply makes attempt n+1.
- **User-requested cancel in `past_due`** (B5): `next_retry_at = grace end`, `cancel_at_period_end = true`; the job never charges such a row and finalizes it at/after the grace end (`user_requested`). Access runs to exactly the grace end by the access rule.
- **Drift during a renewal charge** (settle re-validation, B12): if, while the charge was in flight, the user requested a cancellation, changed/removed the pending plan, or anything moved the period/plan/status, the succeeded charge is **discarded and refunded** (durable pending refund, processed after commit); the next run re-evaluates from the new state (a cancel is then finalized without charge; otherwise a new attempt number is used).
- **Refund processing**: every cycle retries `pending` refunds with their original refund key (idempotent at the provider). An unknown outcome (provider error/timeout) stays `pending` and is retried next cycle, with `resolve_attempts` / `last_checked_at` updated. A definitive provider failure sets the refund `failed` with its `error_message` as a **durable record** (never silently dropped, never retried automatically, reported in the cycle summary for alerting); the original charge stays recorded and the invoice stays `paid`.
- **Scheduling**: `node-cron` (`JOBS_CRON`, default every minute) with an in-process overlap guard; multiple processes are safe because of the row claims above. `RUN_JOBS=false` disables it. Dev only (`NODE_ENV != production`, authenticated): `POST /dev/run-renewals` and `POST /dev/advance-clock` (only with `FAKE_CLOCK=true`).
- **Invoice amounts follow the collected amount**: when a failed invoice is later paid by another attempt, its amount/plan/description are updated to that attempt's (they can legitimately differ, e.g. a re-prorated upgrade).

### B20. Frontend (Stage 7)

- **The UI follows the server, never dates.** Status badges, banners and action hints come only from the server's `status`, `accessAllowed` and flags (`src/lib/subscriptionState.ts`). It never compares dates to decide access, so it always agrees with the backend's `hasAccess` (B19): `active` + `accessAllowed=false` is shown as **Renewal processing** (and the dashboard polls every 5 s until the server says otherwise), then it moves by itself to **Active** (renewed), **grace** (`past_due`, access allowed) or **blocked**, exactly as the server reports. Dates are only displayed (UTC, labelled).
- **Success is shown only after a 2xx.** Dialogs stay open and buttons stay busy while a request is in flight; the confirmation text is built from the server's response. Upgrade amounts are labelled as estimates (the server recomputes at confirmation).
- **Idempotency keys per *intention*** (`api/idempotency.ts`, `hooks/useIntentRunner.ts`): a new intention gets a fresh key; a retry after an UNKNOWN outcome (network error, 5xx, 409 `OPERATION_IN_PROGRESS` / `REQUEST_IN_PROGRESS`) reuses it; every definitive answer (success, 4xx incl. 402 decline, which the server replays for a stored key) ends the intention so the next attempt gets a new key. Single flight: while one billing action runs, all other actions are ignored/disabled, so double clicks and cross-clicks cannot create a second intention.
- **Sessions:** the JWT is kept in `localStorage` (survives reloads; trade-off: readable by any script on the page, so the app must remain XSS-free; the token is short-lived). On load it is validated with `GET /auth/me`; a 401 (`TOKEN_EXPIRED` / invalid) returns the user to login with an explanation; a network failure does **not** log the user out (retry button).
- **API access:** same-origin `/api/*` (Vite dev/preview proxy strips the prefix); `VITE_API_URL` overrides for direct calls. No CORS needed in dev.
- **Backend additions made for the UI (read-only, user-scoped, no state change):** `GET /usage/history` (per-period totals; the UI's "usage history") and `GET /billing/operations` (the caller's payment attempts and refunds, including `pending` ones and **failed refunds**, which no existing endpoint exposed, so "pending", "failed" and "refunded" could not be told apart). Both are tested in `server/tests/billingViews.test.ts`.
- **Backend bug fixed for the UI:** `GET /auth/me` had been under the strict per-IP credential limiter (20 / 15 min). The UI validates the session with it on every page load, so ~20 reloads locked a real user out. The strict limiter now covers `POST /auth/register` and `POST /auth/login` only; `/auth/me` uses the generous per-user limiter (see B14).
- **Failed refunds** are shown on the Billing page as "Refund failed" with a reference and a banner; they are never presented as refunded. This is the diagnostic view for v1 (per user); an operator-wide admin view remains future work.
- **Explicit billing policies** in the UI (Billing page, "How billing works"): missed renewal periods are charged one at a time, not forgiven; month-end anchors can drift (31 Jan → 28 Feb → 28 Mar); access stops at the period end until renewal is processed; the 72-hour grace and retry cadence.
- **Responsive:** tables from `sm:` up; on phones billing data is shown as stacked cards so amounts and status badges never need horizontal scrolling (verified in a real browser at 375 px and 1280 px).

### B14. Auth (detailed for Stage 2)
- bcrypt cost 12 by default (`BCRYPT_COST`; 4 under `NODE_ENV=test` for speed). Passwords: 8 to 72 **bytes** (bcrypt ignores bytes beyond 72, so longer passwords are rejected rather than silently truncated).
- JWT HS256 only (algorithm pinned on verify), payload `{ sub, iat, exp }` — no email, name or other PII. Default expiry 1 h (`JWT_EXPIRES_IN_SECONDS`), no refresh tokens. `iat`/`exp` and the verification time come from the injected `Clock` (verification uses `clockTimestamp`), so expiry is testable with `FakeClock`.
- `JWT_SECRET`: required, at least 32 characters, in production (startup fails otherwise). In development/test an unset secret falls back to a fixed, non-secret development value so the project runs out of the box; this fallback is **rejected in production**. The secret is never logged.
- The authentication middleware verifies the token **and** loads the user from the database (a token for a deleted user is rejected with 401). A database failure there is a 500, never a 401, so clients don't log out on transient errors.
- Login failure: always 401 `INVALID_CREDENTIALS` / "Invalid email or password", for unknown email and wrong password alike. A dummy bcrypt comparison runs for unknown emails so response time doesn't reveal whether an email exists.
- Expired token → 401 `TOKEN_EXPIRED`; any other invalid token → 401 `UNAUTHENTICATED`.
- Emails are trimmed, lowercased, max 254 chars. Registration with an existing email → 409 `EMAIL_TAKEN` (accepted enumeration at registration; login stays generic).
- Rate limiting: the **credential endpoints** (`POST /auth/register`, `POST /auth/login`) share a strict per-IP limiter (default 20 requests / 15 min, configurable); over the limit → 429 `RATE_LIMITED` in the standard error shape. `GET /auth/me` is **not** in that bucket (changed in the frontend stage: the UI calls it on every page load to validate the session, so the strict per-IP cap locked real users out); it uses the generous per-user limiter (`USAGE_RATE_LIMIT_*`, default 600/min) like `/usage`. `trust proxy` is **not** enabled; behind a reverse proxy it must be configured so the client IP is correct.
- `/dev/*` endpoints exist only when `NODE_ENV !== 'production'`; `advance-clock` additionally requires `FAKE_CLOCK=true`.

### B15. Tooling and misc
- IDs: UUID (`gen_random_uuid()`, built into PostgreSQL 13+). PostgreSQL 16 via Docker, host port **5433** (avoids clashing with a local PostgreSQL on 5432). One container, two databases: `subcycle_dev` and `subcycle_test`.
- npm workspaces (`client`, `server`); Node 20+ (developed on 24). Server is CommonJS TypeScript; Express 5.
- **Migrations**: plain `.sql` files in `server/migrations/`, named `NNNN_description.sql`, applied in order by a small TypeScript runner. Each file runs in its own transaction. Applied files are recorded in `schema_migrations` with a SHA-256 checksum; editing an already-applied file is an error. A PostgreSQL advisory lock serialises concurrent runners. Forward-only (no down migrations).
- **Reset** (`db:reset`): drops and recreates the `public` schema, then migrates. Refuses `NODE_ENV=production`, and refuses non-local hosts unless `ALLOW_DB_RESET=true`.
- **Seed** (`db:seed`): idempotent upsert of plans keyed by `code` (re-running updates the rows to the seed values; it never duplicates).
- Bookkeeping `created_at` / `updated_at` columns default to DB `now()`; the application sets `updated_at` from the `Clock` when it updates rows. **Business timestamps** (periods, `paused_at`, `past_due_since`, …) never use DB `now()`.
- Tests run serially (`fileParallelism: false`) against `subcycle_test`, which is reset+migrated once in global setup, and tables are truncated between tests.
- Admin metrics: optional; deferred to polish.

### B16. Seed plans

| code | name | interval | price (paise) | price (INR) | api_calls | projects | seats |
|---|---|---|---|---|---|---|---|
| free | Free | month | 0 | ₹0 | 100 | 1 | 1 |
| pro_monthly | Pro | month | 49900 | ₹499 | 5,000 | 10 | 3 |
| business_monthly | Business | month | 149900 | ₹1,499 | 50,000 | 100 | 25 |
| pro_yearly | Pro (Yearly) | year | 499900 | ₹4,999 | 60,000 | 10 | 3 |

Limits apply **per billing period**, so the yearly plan's `api_calls` is 12× the monthly one. `projects` and `seats` are capacity-style limits and identical to Pro monthly.

## C. Which guarantees PostgreSQL enforces vs. application logic

| Guarantee | Enforced by |
|---|---|
| One non-canceled subscription per user | **DB**: partial unique index on `subscriptions(user_id) WHERE status <> 'canceled'` |
| Valid enum-like values (status, interval, kind, op type/status, cancel reason, event type) | **DB**: CHECK constraints |
| Non-negative prices, quantities, amounts; invoices only for amounts > 0 | **DB**: CHECK |
| `current_period_end > current_period_start`; `retry_count` 0..3; `pending_plan_id <> plan_id` | **DB**: CHECK |
| `paused_at` set iff `paused`; `past_due_since` set iff `past_due`; `canceled_at`/`cancel_reason` set iff `canceled`; `next_retry_at` only when `past_due`; cancel flag implies `cancel_requested_at` | **DB**: CHECK |
| A billing obligation is invoiced at most once; renewals once per subscription period | **DB**: unique `invoices.obligation_key`; partial unique `(subscription_id, billing_period_start) WHERE kind='renewal'` |
| An idempotency key produces at most one billing operation; one attempt number per obligation; at most one pending charge per obligation; at most one refund per charge | **DB**: unique `idempotency_key`; unique `(obligation_key, operation_type, attempt)`; partial unique pending index; unique `refund_of_operation_id` |
| HTTP idempotency keys unique per user | **DB**: unique `(user_id, key)` |
| Atomic usage increments | **DB**: single `INSERT … ON CONFLICT DO UPDATE`, unique `(subscription_id, metric, period_start)` |
| Unique emails, stored lowercase | **DB**: `CHECK (email = lower(email))` + unique |
| Referential integrity | **DB**: foreign keys (`ON DELETE RESTRICT`) |
| Valid state transitions (cannot pause a canceled sub, …) | **App**: state machine in the subscription service, under `SELECT … FOR UPDATE` |
| Interval matching and price ordering for plan changes | **App** |
| Proration amount | **App** (pure function, unit-tested) |
| Grace-period access rule | **App** (single function) |
| Event written in the same transaction as the state change | **App** (transaction helper) |
| No double charge for one obligation | **DB** (unique keys, one pending per obligation) + **App** (Tx 1 checks under row lock) |
| Never a fresh key for an unknown outcome | **App** (attempt allocation rule B7) |
| Renewal job concurrency safety | **DB** (`FOR UPDATE SKIP LOCKED`, row locks) + **App** (idempotent per-subscription processing) |

## D. Open items

None blocking Stage 1.

## E. Revision log (review of Stage 0)

| Item | Change |
|---|---|
| B8 invoices | Replaced `(subscription_id, kind, billing_period_start, plan_id)` uniqueness with a stable `obligation_key` (+ renewal-period partial unique). `plan_id` is informational. |
| B7 attempts | Attempt keys now explicitly never minted for unknown outcomes; HTTP idempotency table specified fully, including abandoned-request recovery. |
| B9 | Approved as proposed. |
| B5 | Approved; added `cancel_requested_at`, job selection rule, boundary documentation. |
| B1 | Grace-start timestamp, retry anchoring, and the 72 h boundary behaviour made exact; job-lag rule changed to "one final attempt". |
| B12 / B10 | Refund no longer inside a DB transaction: compensation is recorded durably then processed after commit and by the job. |
| B16 | Pro Yearly `api_calls` raised to 60,000 (12×). |
| B12a | New: schema supports a future outbox/Stripe design. |

### Review of Stage 1

| Item | Change |
|---|---|
| B5 | **Reversed**: cancel in `past_due` no longer ends grace early. Cancellation is finalized at `grace_ends_at` (job wakes via `next_retry_at = grace_ends_at`, no charge); optional explicit `immediate: true` cancels at once. No migration needed. |
| B6 | Reactivate also allowed in `past_due` before finalization. |
| B3a | Added the pause/resume interaction matrix showing every path respects the `paused_at` CHECK. |
| B12b | New: invoice status must agree with billing-operation records. |
| B13 | Limits tied to the real stored billing period; yearly 60,000 documented as a product decision. |
| B14 | Stage 2 auth details. |

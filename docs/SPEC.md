# SubCycle — Specification

> Source of truth for all stages. Saved verbatim from the project brief (formatting normalised).

## 0. Role and standing rules

Act as a senior full-stack engineer and software architect. Build SubCycle in a monorepo, one stage at a time.

Priorities, in order: correctness, transactional integrity, security, testability, maintainability, clear documentation. Avoid unnecessary complexity.

Standing rules (apply to every stage):

- Implement only the current stage. When done, stop and wait for approval.
- Do not claim code, tests, migrations, or commands work unless you ran them. Paste the real command output (test summary, typecheck, lint).
- If something is ambiguous and a wrong guess would be costly to undo, ask. Otherwise state your assumption, record it in docs/DECISIONS.md, and continue.
- Never contradict docs/DECISIONS.md. If you must change a decision, say so explicitly and ask first.
- Parameterized SQL only. No string-concatenated queries. No ORM.
- Business logic lives in services, never in controllers or routes.
- Never log secrets, password hashes, tokens, or payment details.
- Do not add Redis, queues, microservices, or other infrastructure without a concrete requirement.

Definition of done for every stage:

- Migrations apply cleanly to a fresh database (and are re-runnable via a documented reset script).
- typecheck, lint, and all tests pass, with the output shown.
- README / docs updated for anything new.
- A short summary: what changed, how to run and test it, assumptions made, known limitations.

## 1. Project goal

A full-stack app where authenticated users can:

- Register and log in.
- View plans and their limits.
- Subscribe to a plan.
- Upgrade immediately with proration.
- Schedule downgrades for the end of the current period.
- Pause and resume.
- Schedule cancellation and reactivate before it takes effect.
- Track usage against plan limits, with enforcement.
- View invoices and subscription history.

The focus is lifecycle management, billing logic, concurrency safety, usage metering, and automated renewals. No real payment gateway in v1; use a mock provider that can simulate success and failure.

## 2. Technology stack

Frontend: React, Vite, TypeScript, React Router, Tailwind CSS.

Backend: Node.js, Express, TypeScript, PostgreSQL, pg, plain SQL migrations (a small runner script or node-pg-migrate), JWT, bcrypt, Zod, node-cron, Vitest, Supertest, helmet, cors, express-rate-limit.

Dev environment: Docker Compose for PostgreSQL (separate dev and test databases), .env.example with placeholders only, .gitignore (secrets, deps, build output, env files), root-level scripts (dev, build, test, lint, typecheck, db:migrate, db:seed, db:reset), README with setup and troubleshooting.

Use stable, compatible versions and commit the lockfile.

## 3. Repository structure

```text
subcycle/
├── client/
│   └── src/ { api/, components/, context/, pages/, main.tsx }
├── server/
│   ├── migrations/
│   ├── scripts/
│   ├── src/
│   │   ├── billing/        # BillingProvider, MockProvider
│   │   ├── controllers/
│   │   ├── db/             # pool, transaction helper, queries
│   │   ├── jobs/           # renewal + reconciliation
│   │   ├── lib/            # clock, money, errors
│   │   ├── middleware/
│   │   ├── routes/
│   │   ├── services/
│   │   ├── app.ts
│   │   └── server.ts
│   └── tests/
├── docs/ { SPEC.md, DECISIONS.md, STATE_MACHINE.md }
├── docker-compose.yml
├── package.json
├── .env.example
├── .gitignore
└── README.md
```

You may add files, but keep routes, controllers, services, DB access, and billing separate.

## 4. Fixed decisions (do not re-decide; copy into docs/DECISIONS.md in Stage 0)

| Topic | Decision |
|---|---|
| Currency | INR. All amounts are integers in paise. |
| Time | Store everything in UTC (timestamptz). No local-time logic. |
| Clock | All time comes from an injected Clock interface (now()), never a bare new Date() in business logic. Tests use a fake clock. |
| Free plan | Uses the same lifecycle as paid plans, price 0. No billing-provider calls for zero amounts. Renewal of a free plan just rolls the period and writes an event. |
| Trials | Not in v1. Do not implement trialing. Leave it out of the status enum. |
| One subscription per user | At most one non-canceled subscription per user (partial unique index). Canceled history is kept. |
| Interval changes | Upgrades/downgrades between different intervals (monthly <-> yearly) are rejected with a validation error in v1. |
| Grace period | past_due keeps access for 3 days from the first failed renewal, then access is blocked. Same rule in API, usage middleware, frontend, and tests. |
| Retry policy | A failed renewal is retried once per day, max 3 retries. After that (or when the grace period ends, whichever is first) the subscription is canceled with reason payment_failed. |
| Pending downgrade + pause | A pending downgrade survives a pause. |
| Replacing or removing a pending downgrade | Requesting another downgrade replaces it. DELETE /subscriptions/pending-change removes it. |
| Cancel while paused | Rejected with 409. User must resume first. |
| Cancel + pending downgrade | Cancellation wins at period end; pending plan is cleared on finalization. |
| Rounding | Round half up to the nearest paise, applied once, on the final prorated amount. |

## 5. Database schema

Use explicit SQL migrations with foreign keys, indexes, CHECK constraints, and timestamps.

**users**: id, email (unique, stored lowercase), password_hash, name, created_at.

**plans**: id, code (unique), name, price_cents (>= 0), interval (month | year), limits (JSONB, e.g. {"api_calls":1000,"projects":3,"seats":1}), created_at, updated_at. Seed: Free (0), Pro monthly, Business monthly, and Pro yearly (to exercise the interval-change rejection). Document the prices and limits.

**subscriptions**: id, user_id, plan_id, pending_plan_id (nullable), status (active | paused | past_due | canceled), current_period_start, current_period_end, cancel_at_period_end (bool), paused_at, canceled_at, cancel_reason (nullable), past_due_since (nullable), retry_count (default 0), next_retry_at (nullable), created_at, updated_at. Constraints: current_period_end > current_period_start; partial unique index on user_id where status <> 'canceled'.

**usage_records**: id, subscription_id, metric, period_start, quantity (>= 0), updated_at. Unique on (subscription_id, metric, period_start). Increment only with a single atomic INSERT ... ON CONFLICT DO UPDATE SET quantity = usage_records.quantity + $n.

**invoices**: id, subscription_id, amount_cents, status (paid | failed | refunded), description, billing_period_start, kind (renewal | upgrade_proration | initial), created_at. Unique constraint on (subscription_id, kind, billing_period_start) so a logical renewal can never be invoiced twice. Failed invoices are kept for audit.

**billing_operations**: id, subscription_id, invoice_id (nullable), idempotency_key (unique), operation_type (charge | refund), amount_cents, status (pending | succeeded | failed), provider_reference, error_message, created_at, updated_at. This table separates "an invoice exists" from "an attempt to collect payment", and makes retries safe.

**subscription_events**: id, subscription_id, type, from_status, to_status, meta (JSONB), created_at. Event types must distinguish: subscribed, upgraded, downgrade_scheduled, downgrade_cleared, downgrade_applied, paused, resumed, cancel_scheduled, reactivated, renewed, renewal_failed, canceled.

Add indexes for: subscriptions by user, subscriptions by current_period_end (for the renewal job), past_due retries, invoices by subscription, events by subscription, usage lookups.

## 6. Transaction and concurrency rules

- Provide a reusable transaction helper that begins, commits, rolls back on error, and always releases the client.
- Lock the subscription row with SELECT ... FOR UPDATE before any transition. If multiple rows are ever locked, use a consistent order (by id ascending).
- Keep transactions short. Never hold a transaction open across a network or provider call.
- Enforce critical invariants in the database (constraints, unique indexes) as well as in code.
- Document in docs/DECISIONS.md which guarantees PostgreSQL enforces and which depend on application logic.

### Two-phase billing pattern (mandatory for every charge)

1. **Tx 1**: lock the subscription, validate the transition is allowed, compute the amount, insert a billing_operations row (pending, with a deterministic idempotency key such as `charge:{subscription_id}:{kind}:{period_start}`), commit.
2. **No transaction**: call BillingProvider.charge() with that idempotency key.
3. **Tx 2**: lock the subscription again, re-validate it is still in the expected state, then record the outcome:
   - success: mark the operation succeeded, apply the state change (plan switch, period roll), create the paid invoice, write the audit event;
   - failure: mark the operation failed, create a failed invoice if applicable, apply failure handling (e.g. past_due), write the event. The higher plan is not activated.

Reconciliation: a job finds billing_operations stuck in pending for more than N minutes and resolves them by re-querying the provider by idempotency key (the mock provider supports this lookup).

A repeated request with the same idempotency key must not double-charge.

## 7. Lifecycle and business rules

Implement as an explicit state machine in a service, documented in docs/STATE_MACHINE.md (a diagram plus a transition table). Invalid transitions return HTTP 409 with the standard error shape.

States: active, paused, past_due, canceled.

| Action | Allowed from | Effect |
|---|---|---|
| Subscribe | (no active subscription) | Create active subscription, period starts now, one interval long. Paid plans charge via the two-phase flow; if the charge fails, no subscription is created. |
| Upgrade | active | Immediate. Prorated charge. Rejected from paused, past_due, canceled, or if interval differs. |
| Downgrade | active, paused | Sets pending_plan_id. Current plan and limits stay until period end. |
| Pause | active | Sets paused_at. Stops usage and renewals. |
| Resume | paused | Extends current_period_end by the paused duration, clears paused_at. Must not trigger an immediate renewal. |
| Cancel | active, past_due | Sets cancel_at_period_end. Access continues to period end. Status is not changed yet. Rejected from paused. |
| Reactivate | active with cancel_at_period_end = true, before expiry | Clears cancel_at_period_end. Rejected after final cancellation. |
| Renewal (job) | active past period end | See below. |

### Proration (upgrade)

Use the remaining time of the actual stored period, in milliseconds, not whole days and not a hard-coded month length:

```
remaining_fraction = (current_period_end - now) / (current_period_end - current_period_start)
amount_due = max(0, round_half_up((new_price_cents - old_price_cents) * remaining_fraction))
```

Use integer arithmetic (BigInt or careful integer math) and round once, at the end. If amount_due is 0, do not call the provider; still switch the plan, write an invoice of 0 only if you decide invoices should exist for zero-value changes (record that choice in DECISIONS.md), and write the event. If the charge fails, the plan is not changed and the user can retry safely.

### Renewal (job, per subscription)

For active subscriptions with current_period_end <= now:

- If cancel_at_period_end: set status canceled, set canceled_at, clear pending_plan_id, write canceled.
- Else determine the plan for the next period (pending_plan_id if set, otherwise the current plan).
- If the price is 0: roll the period, apply the pending plan, write events. No provider call.
- Else run the two-phase charge. On success: roll the period forward by one interval from the old current_period_end (not from now), apply the pending plan, clear it, create the paid invoice, write renewed (and downgrade_applied if relevant). On failure: create a failed invoice, set past_due, set past_due_since, set next_retry_at, write renewal_failed. The paid period is not extended.

For past_due subscriptions with next_retry_at <= now: retry the charge. On success, return to active and roll the period. On failure, increment retry_count; after 3 failed retries or when the grace period ends, cancel with reason payment_failed.

The job must be idempotent and safe to run concurrently (use row locking and FOR UPDATE SKIP LOCKED when selecting due rows). Process each subscription in its own transaction so one failure does not block the batch.

### Audit log

Every successful transition writes its event in the same transaction as the state change. Include old/new plan, period boundaries, amounts, and reasons in meta.

## 8. Billing abstraction

```ts
interface BillingProvider {
  charge(input: { amountCents: number; idempotencyKey: string; subscriptionId: string; description: string }): Promise<ChargeResult>;
  refund(input: { providerReference: string; amountCents: number; idempotencyKey: string }): Promise<RefundResult>;
  lookup(idempotencyKey: string): Promise<OperationLookup | null>;   // for reconciliation
}
```

MockProvider: succeeds by default; a documented env flag (e.g. MOCK_BILLING_FAIL=always|never|random:0.3) simulates failures; behavior is deterministic in tests; returns structured results; honors idempotency keys (same key returns the same result without a second "charge"); never logs sensitive data.

Leave a documented integration point and a stub file for a future StripeProvider. Do not implement it.

## 9. Usage tracking and limits

- POST /usage records { metric, quantity } for the authenticated user's current period.
- GET /usage returns current-period usage versus plan limits for every metric.
- Middleware enforceLimit(metric, quantity = 1):
  - rejects if the subscription is paused, canceled, or past_due beyond the grace period (402);
  - rejects if usage + quantity would exceed the limit (429 with limit, used, and remaining in the body);
  - otherwise increments atomically. The check and increment must not be a read-then-write race; implement as a single conditional atomic statement or inside one locked transaction.
- Usage periods align with current_period_start. Usage resets naturally when the period rolls. Pause freezes usage; resume keeps the same period.
- Add a demo endpoint POST /demo/generate-report protected by enforceLimit('api_calls') so limits can be shown live.

## 10. API

All responses use a consistent error shape: `{ "error": { "code": "STRING_CODE", "message": "human readable", "details": {} } }`. Validate all input with Zod. Return correct status codes (400 validation, 401 unauthenticated, 402/429 limits, 404, 409 invalid transition).

- Auth: POST /auth/register, POST /auth/login, GET /auth/me
- Plans: GET /plans
- Subscription: POST /subscriptions, GET /subscriptions/current, GET /subscriptions/history, POST /subscriptions/upgrade, /downgrade, /pause, /resume, /cancel, /reactivate, DELETE /subscriptions/pending-change, GET /subscriptions/upgrade-preview?planId= (returns the prorated amount without charging)
- Usage: POST /usage, GET /usage
- Billing: GET /invoices
- Dev only (disabled in production): POST /dev/run-renewals, POST /dev/advance-clock (works only with the fake clock enabled by env)
- Optional admin: GET /admin/metrics (MRR, active subscriptions by plan, churn)

Lifecycle endpoints should accept an optional Idempotency-Key header and return the original result for a repeated key.

## 11. Security

- Passwords hashed with bcrypt (sensible cost factor); minimum length 8.
- JWT secret from env, short expiry (e.g. 1h). Fail startup if the secret is missing in production.
- helmet, explicit CORS allow-list, request body size limit.
- Rate limiting on /auth/* and on /usage.
- Authorization on every query: a user can only see or modify their own subscription, invoices, and usage.
- Generic error messages for login failures (no user enumeration).
- Never return password_hash. Never log tokens or secrets.

## 12. Frontend

Pages: Login/Register, Pricing (plan cards), Dashboard (plan, status badge, renewal date, usage progress bars, banner for past_due and scheduled cancellation/downgrade), Manage Plan (upgrade with proration preview, schedule/remove downgrade, pause/resume, cancel/reactivate with confirmation dialogs), Invoices, History (events timeline).

Use an AuthContext, a typed API client that attaches the JWT and handles 401 by logging out, loading and error states, accessible responsive UI, and disabled buttons while requests are in flight (to prevent double submits). The grace-period rule must match the backend exactly.

## 13. Testing

- Separate test database, migrated and reset between test files (or truncated between tests).
- Unit tests: state machine (every valid and invalid transition), proration math (including period boundaries, leap-year February, rounding edge cases, zero amounts), grace-period logic.
- Integration tests (Supertest): auth, every lifecycle endpoint, error shapes, authorization (user A cannot touch user B's data).
- Concurrency tests (Promise.all): two simultaneous upgrades result in exactly one charge and one plan change; simultaneous pause and cancel resolve to one consistent state; 100 concurrent usage increments sum correctly and never exceed the limit; repeated identical Idempotency-Key requests produce one operation.
- Failure-path tests: provider fails on upgrade (plan unchanged, retry works); provider fails on renewal (past_due, period not extended); crash between phase 1 and phase 3 (reconciliation recovers).
- Job tests with the fake clock: renewal, pending downgrade applied, cancellation finalized, retries and grace-period expiry, job run twice produces no duplicates.

## 14. Stages

Stop after each stage and wait for approval.

0. **Decisions.** Create docs/DECISIONS.md (from section 4, plus any additional assumptions) and docs/STATE_MACHINE.md (diagram and transition table). No code. I approve or edit before Stage 1.
1. **Foundation.** Monorepo, tooling, Docker Compose, env handling, migration runner, all migrations, seed data, transaction helper, Clock, error shape, health check, test setup with a test DB.
2. **Auth.** Register, login, me, JWT middleware, rate limiting, tests.
3. **Billing layer.** BillingProvider, MockProvider, billing_operations flow, two-phase charge helper, idempotency, tests.
4. **Subscription service.** State machine, subscribe/upgrade/downgrade/pause/resume/cancel/reactivate, proration, audit events, routes, unit + integration + concurrency tests.
5. **Usage and limits.** Usage endpoints, enforceLimit, demo endpoint, concurrency tests.
6. **Renewal and reconciliation jobs.** Cron wiring, dev trigger endpoints, retry/grace logic, job tests with the fake clock.
7. **Frontend.** All pages and flows, tested manually against the running backend.
8. **Polish.** README (setup, architecture, state diagram, API reference), troubleshooting, CI workflow running typecheck/lint/tests, final review of security checklist, list of known limitations and future work (Stripe, trials, interval changes, email notifications).

### Kickoff prompt (paste at the start of each stage)

> Read docs/SPEC.md and docs/DECISIONS.md in full. Implement only Stage N of section 14. Follow the standing rules and definition of done. Run the typecheck, lint, and tests and show the real output. Then stop with a summary (what changed, how to run it, assumptions, limitations) and wait for my approval.

For the very first message: "Read docs/SPEC.md. Implement Stage 0 only."

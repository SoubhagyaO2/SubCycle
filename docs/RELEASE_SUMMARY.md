# SubCycle v1: release summary

A full-stack subscription-billing platform: users register, pick a plan, upgrade with proration, schedule downgrades, pause, cancel and
reactivate, and are metered against plan limits, while background jobs renew subscriptions, retry failed payments and recover from
uncertain payment outcomes. **Billing is mock-only** (no real money moves); see [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).
This is a complete portfolio project, **not** certified for real-money production use.

## Architecture

```
React 19 + Vite + Tailwind  ──/api──►  Express 5 (TypeScript)  ──pg──►  PostgreSQL 16
 8 screens, server-driven state         routes → controllers → services      11 tables, 6 SQL migrations
                                        (all business logic in services)       constraints enforce invariants
                                          │
                                          ├─ BillingProvider (MockProvider; Stripe stub documents the contract)
                                          └─ node-cron job cycle: reconcile → refunds → renewals → housekeeping
```

- **Backend:** plain parameterized SQL (no ORM), a transaction helper, an injected `Clock` (no `new Date()` in business code, enforced by lint), Zod validation on every input, JWT + bcrypt, helmet/CORS/rate limits.
- **State machine:** explicit and documented ([STATE_MACHINE.md](STATE_MACHINE.md)); transitions run under `SELECT … FOR UPDATE`, and every state change writes its audit event in the same transaction.
- **Frontend:** the UI is driven only by the server's `status` and `accessAllowed`, never by comparing dates, so it cannot disagree with the backend's access policy.
- **Scale of the project:** 24 routes, 6 migrations, 11 tables, 409 server tests, 186 client tests, 42 real-browser checks.

## The hard problems, and how they were handled

| Problem | Approach |
|---|---|
| **Charging safely when the network can fail anywhere** | Every charge is a durable `billing_operations` row committed **before** the provider is called (two-phase). If the outcome is unknown (timeout, lost response, crash, or a database failure after the money was taken), the attempt stays `pending` and is resolved by looking up the **same** idempotency key. A new attempt key is only minted after a definitive failure, so a lost response can never cause a second charge. |
| **State changed while a payment was in flight** | The settle step re-validates under lock. If the world moved (paused, canceled, plan changed), the succeeded charge is discarded and a compensating refund is recorded durably, then processed after commit. |
| **Concurrency** | Row locks, partial unique indexes (one pending charge per obligation, one open subscription per user, one renewal per period), `FOR UPDATE SKIP LOCKED` for the job, and a share lock so pause/cancel/upgrade serialize with usage. |
| **Usage limits that cannot be exceeded** | One conditional upsert checks the limit and increments atomically. Usage is consumed iff the metered operation commits (rollback on any ≥ 400, a failing commit returns 500, never success). An exactly-once ledger via `Idempotency-Key`. |
| **The period boundary** | Access stops at exactly `current_period_end`, the same instant the job treats the subscription as due, using one function shared by the API, usage checks and job. Grace after a failed renewal is exactly 72 h; the retry due at the grace end still runs; a user cancel during grace stops retries but keeps the grace. |
| **Idempotency at two layers** | Per-user HTTP `Idempotency-Key` (replay, mismatch 422, in-progress 409, abandoned-request takeover, 5xx never stored) over provider-level obligation/attempt keys. |

## Testing strategy

- **Deterministic concurrency tests.** No sleeps: a gate parks a request *inside* the provider, and a barrier waits until PostgreSQL reports a backend blocked on a lock. Simultaneous-start tests assert only order-independent invariants.
- **Mutation-checked.** The key protections were deliberately broken to confirm tests fail: unknown outcome treated as failure, no re-validation at settle, no limit check, no subscription lock, no `SKIP LOCKED`, a cancellation not winning at renewal, a drifting retry schedule, a missing `no-store` header, an unscoped query, the production guard for `/dev`, raw-HTML rendering, an undocumented route.
- **Layers.** Pure unit tests (proration with BigInt, every state-machine transition across 288 combinations); integration tests against real PostgreSQL; failure injection (database triggers that fail Tx 2 or the commit); a security suite whose route inventory is parsed from the source and must match `docs/API.md`; client tests with `fetch` mocked at the boundary; **11 tests that render the real UI against the real spawned server and database**; axe and keyboard tests; an optional Playwright suite in real Chromium at 375 px and 1280 px.
- **Bugs the tests found in my own work** (kept as lessons): an invoice kept a stale amount when a failed upgrade was paid on retry; a job runner skipped the job when no summary hook was passed (`hook?.(await run())`); a billing table clipped its status column on phones; `/auth/me` shared the strict login limiter and would have locked users out on reload.

## Results

| Check | Result |
|---|---|
| Typecheck, lint, production builds | clean |
| Fresh-database migration + seed check | 5/5 |
| Server tests / client tests | 409 / 186 passed, run twice, sequentially (they share the test database) |
| Browser suite (Chromium) | 42/42 |
| `npm audit` | 0 vulnerabilities |
| GitHub Actions (CI) | passing on `d808e13`, tagged `v1.0.0-rc.1` (run #3, 1 m 57 s); run #2 failed once for an unexplained reason, see [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) |

## Run it

```bash
npm install
cp .env.example .env
npm run db:up && npm run db:migrate && npm run db:seed
npm run dev        # API :4000, web :5173
npm test           # server suite, then client suite (needs the database)
```

To try renewals without waiting a month, start the API with `FAKE_CLOCK=true` and use `POST /dev/advance-clock` and `POST /dev/run-renewals` (never available in production).

## Limitations (the honest part)

Mock-only billing; JWT in `localStorage` with no server-side revocation; in-process, in-memory scheduling and rate limiting; failed refunds are visible to the user but have no operator tooling or alerting; no operator-wide admin view; missed renewal periods are charged rather than forgiven; month-end billing dates drift (31 Jan → 28 Feb → 28 Mar). Full register with reasoning and the way out for each: [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) and [SECURITY.md](SECURITY.md).

## Where to look first

[API.md](API.md) (reference) · [DECISIONS.md](DECISIONS.md) (every decision and why, B1–B21) · [STATE_MACHINE.md](STATE_MACHINE.md) · `server/src/services/billingOperations.ts`, `chargeSettlement.ts`, `renewalService.ts` (the billing core) · `server/tests/billingConcurrency.test.ts`, `security.test.ts`.

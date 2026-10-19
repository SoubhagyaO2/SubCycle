# Known limitations

These are deliberate v1 trade-offs, not hidden defects. Each states what happens, why, and the way out.
Related: [SECURITY.md](SECURITY.md) (residual risks), [DECISIONS.md](DECISIONS.md) (the reasoning), [API.md](API.md).

## Billing

| Limitation | What actually happens | Way out |
|---|---|---|
| **Billing is mock-only** | Payments go to `MockProvider` (`MOCK_BILLING_FAIL=never|always|random:p`). No real money moves and no card data exists anywhere. `StripeProvider` is an unimplemented stub documenting the contract. | Implement `BillingProvider` for a real gateway (same two-phase, idempotency-key and lookup contract), add webhook ingestion (verified signatures, de-duplicated event ids), and re-run the security review. |
| **Catch-up billing: missed periods are charged, not forgiven** | If the renewal job is down for N periods, each period is renewed, charged and invoiced separately, one per job run. A user who was inactive through an outage can therefore be charged several times in a row. The UI says so on the Billing page. | Add a policy (skip or credit missed periods) before production; v1 chooses the conservative "collect what was owed" rule. |
| **Month-end anchor drift** | Period arithmetic is calendar-month in UTC with day clamping and rolls from the previous end: 31 Jan → 28 Feb → 28 Mar (it does not return to the 31st). | Store an anchor day on the subscription and clamp from it. |
| **Access gap while a renewal is pending** | Access stops at exactly `current_period_end` and returns when the job renews it (the dashboard follows the server). If the job is late, or the renewal then fails, the user is blocked until the job runs and then gets the 72-hour grace from the failure time. Keep the job running every minute. | Anchor grace at the period end, or allow a short bounded lag; both change the documented policy (B19). |
| **Failed refunds are visible but not operated** | A compensating refund that the provider definitively rejects is stored as `failed` with its error and shown to the affected user ("Refund failed", with a reference). It is **not** retried automatically (unknown outcomes are retried with the same key; definitive failures are not), and there is no alert. | Operator tooling to review, retry or write off failed refunds, plus alerting on `billing_operations.status='failed' AND operation_type='refund'`. |
| **No operator-wide admin view** | Each user sees only their own invoices, payment attempts and refunds. The optional `GET /admin/metrics` (MRR, churn) was not built, and there is no cross-user view of stuck operations. | Add an admin role and the metrics/diagnostics endpoints. |
| **Intervals cannot change; no trials; no coupons or taxes; one subscription per user; INR only** | Upgrades/downgrades between monthly and yearly are rejected. | Product work; the schema separates these concerns. |
| **Downgrades are not refunded** | A downgrade takes effect at period end; nothing is credited for unused higher-plan time. | Credit-on-downgrade policy. |

## Scheduling and scale

| Limitation | What actually happens | Way out |
|---|---|---|
| **Scheduling is in-process** | `node-cron` runs inside each API process (`RUN_JOBS`). There is no leader election and no separate worker. Several processes are **safe** (every subscription is claimed with `FOR UPDATE SKIP LOCKED`, due-ness is re-checked, charges are idempotent) but they all poll. If every process is down, nothing renews until one returns. | A dedicated worker deployment, or a platform scheduler calling the job entry point. |
| **Rate limiting is per process and in memory** | Counters are not shared between API processes or restarts; the login limiter keys on IP and `trust proxy` is not configured, so behind a proxy all clients share one bucket. | Shared store or edge rate limiting; configure trust proxy. |
| **Reconciliation is eventual** | An unknown payment outcome stays `pending` (never counted as paid) until the next job cycle or the user's retry resolves it by looking up the original provider key. | Shorter job interval; provider webhooks. |
| **No outbox worker / email notifications** | Refund processing and reconciliation run from the job cycle. No emails (payment failed, receipt, cancellation) are sent. | Notification service driven by `subscription_events`. |

## Security and sessions

| Limitation | Detail |
|---|---|
| **JWT in `localStorage`** | Readable by any script on the page; the app relies on staying XSS-free (text-only rendering, lint bans on raw HTML and `eval`, recommended CSP in SECURITY.md). Tokens last 1 hour, there is **no refresh token and no server-side revocation**: "Sign out" only removes the token from the browser. Moving to an `HttpOnly` cookie needs CSRF protection and a refresh flow. |
| **Email enumeration at registration** | `409 EMAIL_TAKEN` reveals that an address is registered (login does not). |
| **No email verification, password reset or MFA** | Out of scope for v1. |

## Product and UI

| Limitation | Detail |
|---|---|
| **Single language, INR, UTC** | Dates are displayed in UTC (labelled); amounts in INR. |
| **Browser suite is optional** | Real-browser regressions are covered by the opt-in Playwright workflow (`npm run e2e`, `.github/workflows/e2e-browser.yml`), not by the required CI. Responsive layout and real-keyboard behaviour are otherwise only covered by jsdom/axe tests. |
| **Fake-clock sessions** | With `FAKE_CLOCK=true` (development only) tokens expire on the fake clock, so large clock jumps require signing in again. |
| **Tests share one database** | The server suite and the client's real-backend suite both reset `TEST_DATABASE_URL`; they must run one after the other (the root `npm test` and CI do). |

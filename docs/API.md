# SubCycle API reference

Every example below was captured from the running server (`server/src`), not written from memory. A test
(`server/tests/security.test.ts`) fails if a route exists in the code but has no `###` heading here, or the reverse.

- [Conventions](#conventions)
- [Errors](#errors)
- [Idempotency](#idempotency)
- [Authentication](#authentication-routes) · [Plans](#plans) · [Subscriptions](#subscriptions) · [Usage](#usage) · [Billing](#billing) · [Health](#health) · [Development only](#development-only)

## Conventions

| Topic | Rule |
|---|---|
| Base URL | The server root, e.g. `http://localhost:4000`. The web app reaches it through a same-origin `/api` proxy that strips the prefix (see README). |
| Format | JSON in, JSON out (`Content-Type: application/json`). Request bodies are limited to 100 kB (`413 PAYLOAD_TOO_LARGE`). |
| Authentication | `Authorization: Bearer <JWT>` (HS256, 1 h by default, payload `sub`/`iat`/`exp` only). No cookies, so no CSRF surface. The token is never accepted from a query string. |
| Money | Integer **paise** (INR) in fields named `…Cents`. |
| Time | ISO-8601 UTC strings (`2026-10-19T18:21:12.477Z`). |
| IDs | UUIDs. |
| Validation | Every body and query is validated with Zod; request bodies are **strict** (unknown fields are rejected with 400). |
| Caching | Every response carries `Cache-Control: no-store`. |
| CORS | Explicit allow-list (`CORS_ORIGINS`), no wildcard, no credentials. Browsers may send `Authorization`, `Content-Type`, `Idempotency-Key`; `Idempotent-Replay` and rate-limit headers are exposed. |
| Rate limits | `POST /auth/register` and `POST /auth/login`: 20 / 15 min per IP (shared bucket). `GET /auth/me`, `/usage*`, `/demo/*`: 600 / min per **user**. Over the limit: `429 RATE_LIMITED`. |
| Authorization | Every authenticated route reads and writes only the caller's own subscription, usage, invoices and operations; user ids come from the token, never from the request. |

## Errors

Every error has the same shape; `details` is always an object (possibly empty). Messages are safe to show to users.

```json
{ "error": { "code": "INVALID_TRANSITION", "message": "There is no scheduled plan change to remove",
             "details": { "action": "removePendingChange", "reason": "no_pending_change", "status": "active" } } }
```

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Bad input. `details.fields` lists `{ path, message }` for body/query errors; `details.reason` / `details.code` (e.g. `UNKNOWN_METRIC`, `FAKE_CLOCK_DISABLED`) refine business-rule violations such as a plan change between monthly and yearly. Malformed JSON is also a 400. |
| 401 | `UNAUTHENTICATED` | Missing, malformed, forged or otherwise invalid token (or the user no longer exists). |
| 401 | `TOKEN_EXPIRED` | Valid token, past its expiry. |
| 401 | `INVALID_CREDENTIALS` | Login failed. Identical for an unknown email and a wrong password. |
| 402 | `PAYMENT_FAILED` | The payment provider declined. Nothing was changed. |
| 402 | `SUBSCRIPTION_REQUIRED` | Usage requires an open subscription and there is none. |
| 402 | `SUBSCRIPTION_INACTIVE` | Usage refused by the access policy: paused, grace period over, or the billing period has ended and renewal is not processed yet (`details.reason` = `paused` / `grace_expired` / `period_ended`). |
| 404 | `SUBSCRIPTION_NOT_FOUND` | No open subscription (lifecycle actions, `GET /subscriptions/current`, `GET /usage`). |
| 404 | `PLAN_NOT_FOUND` | Unknown plan id. |
| 404 | `ROUTE_NOT_FOUND` | No such route. |
| 409 | `INVALID_TRANSITION` | The state machine forbids the action (`details.action`, `details.reason`, `details.status`). |
| 409 | `EMAIL_TAKEN` | Registration with an existing email. |
| 409 | `OPERATION_IN_PROGRESS` | A payment for this change is still being confirmed. Retry later; you will not be charged twice. |
| 409 | `STATE_CHANGED` | The subscription changed while the payment was processing. The charge is refunded. |
| 409 | `REQUEST_IN_PROGRESS` | A request with the same `Idempotency-Key` is still running. |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 100 kB. |
| 422 | `IDEMPOTENCY_KEY_REUSED` | The same key was used for a different request. |
| 429 | `LIMIT_EXCEEDED` | A plan limit would be exceeded (`details`: `metric`, `limit`, `used`, `remaining`, `requested`, `periodEnd`). Nothing was consumed. |
| 429 | `RATE_LIMITED` | Too many requests (not related to plan limits). |
| 500 | `INTERNAL_ERROR` | Unexpected failure. Always generic: no stack traces, SQL or provider details are ever returned. |

## Idempotency

**Lifecycle endpoints** (`POST /subscriptions`, `/subscriptions/upgrade|downgrade|pause|resume|cancel|reactivate`,
`DELETE /subscriptions/pending-change`) accept an optional `Idempotency-Key` header (1–255 printable ASCII characters),
scoped to the authenticated user.

| Situation | Result |
|---|---|
| First request with a key | Runs normally. 2xx and deterministic 4xx outcomes (including `402 PAYMENT_FAILED`) are stored for 24 h. |
| Same key, same request | The **original status and body** are returned with the header `Idempotent-Replay: true`; nothing runs again. |
| Same key, different method, path or body | `422 IDEMPOTENCY_KEY_REUSED`. |
| Same key while the first is still running | `409 REQUEST_IN_PROGRESS`. |
| First request died (process crash) | After 60 s the next identical request takes over and re-runs; this is safe because billing is idempotent per obligation. |
| 5xx, `OPERATION_IN_PROGRESS`, `REQUEST_IN_PROGRESS`, `RATE_LIMITED` | **Not stored**, so retrying with the same key resumes the work. |
| After a stored decline (402) | Use a **new** key for a genuinely new attempt (the old one replays the decline). |

Independently of the header, payments are protected end to end: every charge is a durable operation recorded before the
provider is called, and an unknown outcome is resolved by looking up the **same** provider key, never by a new attempt.

**`POST /usage`** uses the header differently: it becomes `usage_events.request_key`, so recording is exactly-once even across
crashes (the dedupe record commits in the same transaction as the counter). A repeat returns `200` with `"replayed": true`.
`POST /demo/generate-report` does not use idempotency keys: each call is one new, atomic, metered operation.

---

## Authentication routes

### POST /auth/register

Public. Strict per-IP limiter.

```json
{ "email": "asha@example.com", "password": "correct horse battery", "name": "Asha Rao" }
```

Email is trimmed and lower-cased (≤ 254 chars); password 8–72 **bytes**; name 1–100 characters.

`201`:
```json
{ "user": { "id": "343e9758-1c98-476b-b6fa-ff7830be2737", "email": "asha@example.com", "name": "Asha Rao", "createdAt": "2026-10-19T18:21:12.029Z" },
  "token": "eyJhbGciOiJIUzI1NiIsInR5…", "expiresAt": "2026-10-19T19:21:12.000Z" }
```

Errors: `400 VALIDATION_ERROR`
```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Invalid request", "details": { "fields": [
  { "path": "email", "message": "Invalid email address" },
  { "path": "password", "message": "Password must be at least 8 characters" },
  { "path": "name", "message": "Name is required" } ] } } }
```
`409 EMAIL_TAKEN` (registration reveals whether an email exists; login does not), `429 RATE_LIMITED`.

### POST /auth/login

Public. Strict per-IP limiter (shared with register). Body `{ "email", "password" }`. `200` has the same shape as register.

`401 INVALID_CREDENTIALS` is identical for an unknown email and a wrong password:
```json
{ "error": { "code": "INVALID_CREDENTIALS", "message": "Invalid email or password", "details": {} } }
```

### GET /auth/me

Bearer. Validates the session and returns the user. Used by the web app on every page load, so it is **not** in the strict limiter.

`200`: `{ "user": { "id": "…", "email": "…", "name": "…", "createdAt": "…" } }`
`401 UNAUTHENTICATED` / `TOKEN_EXPIRED`.

## Plans

### GET /plans

Public. Plans ordered by price. `limits` values are integers, `0` = not allowed, `null` = unlimited.

`200`:
```json
{ "plans": [
  { "id": "10343e8d-8c86-4cf4-bd43-ef17696f472e", "code": "free", "name": "Free", "priceCents": 0, "interval": "month",
    "limits": { "seats": 1, "projects": 1, "api_calls": 100 } },
  { "id": "a3f880cf-987f-40a2-8c77-0d4281713af3", "code": "pro_monthly", "name": "Pro", "priceCents": 49900, "interval": "month",
    "limits": { "seats": 3, "projects": 10, "api_calls": 5000 } } ] }
```
(The seed also has `business_monthly` ₹1,499 and `pro_yearly` ₹4,999.)

## Subscriptions

All routes need a Bearer token. A user has at most one non-canceled subscription. Mutating routes return
`{ "subscription": <view> }` where the view is:

```json
{ "id": "de035929-…", "status": "active", "plan": { "id": "…", "code": "free", "name": "Free", "priceCents": 0, "interval": "month", "limits": { "seats": 1, "projects": 1, "api_calls": 100 } },
  "pendingPlan": null, "currentPeriodStart": "2026-10-19T18:21:12.477Z", "currentPeriodEnd": "2026-11-19T18:21:12.477Z",
  "cancelAtPeriodEnd": false, "cancelRequestedAt": null, "pausedAt": null, "canceledAt": null, "cancelReason": null,
  "pastDueSince": null, "graceEndsAt": null, "retryCount": 0, "nextRetryAt": null, "accessAllowed": true, "createdAt": "2026-10-19T18:21:12.477Z" }
```

`accessAllowed` is the server's verdict and the **only** thing clients should use to decide access: `active` allows access
strictly before `currentPeriodEnd` (access stops at that exact instant until the renewal job has processed it), `past_due` allows it
strictly before `graceEndsAt` (72 h after the first failed renewal), `paused` and `canceled` never. Allowed transitions are listed in
[STATE_MACHINE.md](STATE_MACHINE.md).

### GET /subscriptions/current

`200`: `{ "subscription": <view> }` · `404 SUBSCRIPTION_NOT_FOUND` when the user has no open subscription.

### GET /subscriptions/history

The caller's audit events, oldest first. `200`:
```json
{ "events": [
  { "id": "92c573f8-…", "subscriptionId": "de035929-…", "type": "subscribed", "fromStatus": null, "toStatus": "active",
    "meta": { "plan_id": "10343e8d-…", "amount_cents": 0, "period_start": "2026-10-19T18:21:12.477Z", "period_end": "2026-11-19T18:21:12.477Z" },
    "createdAt": "2026-10-19T18:21:12.477Z" } ] }
```
Event `type` is one of: `subscribed`, `upgraded`, `downgrade_scheduled`, `downgrade_cleared`, `downgrade_applied`, `paused`, `resumed`,
`cancel_scheduled`, `reactivated`, `renewed`, `renewal_failed`, `canceled`, `charge_discarded`.

### GET /subscriptions/upgrade-preview

Query `planId=<uuid>`. Read-only: what an upgrade would cost **now**; never charges. The charge at confirmation is recomputed by the server.

`200`:
```json
{ "preview": { "fromPlan": { "code": "free", "…": "…" }, "toPlan": { "code": "pro_monthly", "…": "…" }, "amountCents": 49900, "chargeRequired": true,
  "remainingMs": 2678399976, "totalMs": 2678400000, "periodStart": "2026-10-19T18:21:12.477Z", "periodEnd": "2026-11-19T18:21:12.477Z", "computedAt": "2026-10-19T18:21:12.501Z" } }
```
`amountCents = max(0, round_half_up((newPrice − oldPrice) × remainingMs / totalMs))` with BigInt arithmetic. Errors: `400` (missing/invalid `planId`; same plan; not higher; different interval),
`404`, `409 INVALID_TRANSITION` (not active, or the period has ended and renewal is pending: `reason: "renewal_due"`).
```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Plan changes between monthly and yearly billing are not supported", "details": { "reason": "interval_mismatch" } } }
```

### POST /subscriptions

Subscribe. Body `{ "planId": "<uuid>" }`. Idempotency-Key supported. Free plans activate immediately; paid plans are charged first (two-phase) and **no subscription is created if the charge fails**.

`201`: `{ "subscription": <view> }`. Errors: `402 PAYMENT_FAILED`, `404 PLAN_NOT_FOUND`, `409 INVALID_TRANSITION` (already subscribed), `409 OPERATION_IN_PROGRESS`, `409 STATE_CHANGED`, `422 IDEMPOTENCY_KEY_REUSED`.
```json
{ "error": { "code": "INVALID_TRANSITION", "message": "You already have a subscription. Change plans from the Manage Plan page.",
             "details": { "action": "subscribe", "reason": "already_subscribed", "status": "active" } } }
```
A replay of the same request returns the original `201` with `Idempotent-Replay: true`; the same key with another plan returns `422`.

### POST /subscriptions/upgrade

Body `{ "planId": "<uuid>" }`. Idempotency-Key supported. Immediate upgrade with a prorated charge (only from `active`, only to a higher-priced plan with the same interval; a scheduled downgrade is cleared). If the prorated amount rounds to 0 the plan switches with no charge or invoice (still audited).

`200`: `{ "subscription": <view> }`. Errors: `400` (invalid plan change), `402 PAYMENT_FAILED`, `404`, `409 INVALID_TRANSITION` / `OPERATION_IN_PROGRESS` / `STATE_CHANGED`.

### POST /subscriptions/downgrade

Body `{ "planId": "<uuid>" }`. Idempotency-Key supported. Schedules a move to a cheaper plan (same interval) at period end; replaces any pending change. Allowed from `active` and `paused`.

`200`: `{ "subscription": <view> }` with `pendingPlan` set. Errors: `400`, `404`, `409`.

### DELETE /subscriptions/pending-change

Idempotency-Key supported. Removes the scheduled downgrade. `200`: `{ "subscription": <view> }`; `409 INVALID_TRANSITION` (`reason: "no_pending_change"`).

### POST /subscriptions/pause

Idempotency-Key supported; no body. `active` → `paused` (refused once the period has ended: `renewal_due`). `200`: `{ "subscription": <view> }` (`status: "paused"`, `pausedAt` set); `409`.

### POST /subscriptions/resume

Idempotency-Key supported; no body. `paused` → `active`; the current period is extended by the paused time; never charges. `200` / `409`.

### POST /subscriptions/cancel

Idempotency-Key supported. Body optional: `{ "immediate": true }`.

- Default: schedules cancellation at the end of the period (`cancelAtPeriodEnd: true`); access continues. In `past_due` it also stops retries and the job finalizes it at the end of the 72 h grace without charging.
- `{ "immediate": true }`: only from `past_due`; cancels now (`400` otherwise).

`200`: `{ "subscription": <view> }`. Errors: `400`, `409 INVALID_TRANSITION` (already scheduled; or paused: `reason: "cancel_while_paused"`).
```json
{ "error": { "code": "INVALID_TRANSITION", "message": "Resume the subscription before canceling it",
             "details": { "action": "cancel", "reason": "cancel_while_paused", "status": "paused" } } }
```

### POST /subscriptions/reactivate

Idempotency-Key supported; no body. Undoes a scheduled cancellation (`active` before the period end, or `past_due` before it is finalized). `200` / `409`.

## Usage

### GET /usage

Current usage for every metric of the current plan, scoped to the stored billing period. Works for any open subscription (also paused: it is read-only). `404 SUBSCRIPTION_NOT_FOUND` without one.

`200`:
```json
{ "subscription": { "id": "de035929-…", "status": "active", "accessAllowed": true, "graceEndsAt": null },
  "period": { "start": "2026-10-19T18:21:12.477Z", "end": "2026-11-19T18:21:12.487Z" },
  "usage": [ { "metric": "api_calls", "used": 0, "limit": 5000, "remaining": 5000, "unlimited": false },
             { "metric": "projects", "used": 0, "limit": 10, "remaining": 10, "unlimited": false } ] }
```

### POST /usage

Body `{ "metric": "api_calls", "quantity": 5 }`: metric `^[a-z][a-z0-9_]{0,62}$` and part of the plan; quantity an integer 1–1,000,000. Optional `Idempotency-Key` makes recording exactly-once (see above). The limit check and increment are one atomic statement; a request that does not fully fit consumes nothing.

`201` (first time) / `200` (replay):
```json
{ "usage": { "metric": "api_calls", "used": 5, "limit": 5000, "remaining": 4995, "unlimited": false }, "replayed": false,
  "period": { "start": "2026-10-19T18:21:12.477Z", "end": "2026-11-19T18:21:12.487Z" } }
```
Errors:
- `402 SUBSCRIPTION_REQUIRED` / `SUBSCRIPTION_INACTIVE`
- `400` unknown metric (`details.code: "UNKNOWN_METRIC"`, `details.allowed`), bad quantity (`details.field: "quantity"`)
- `422 IDEMPOTENCY_KEY_REUSED` (same key, different metric or quantity)
- `429 LIMIT_EXCEEDED`
```json
{ "error": { "code": "LIMIT_EXCEEDED", "message": "Limit reached for \"api_calls\"",
             "details": { "metric": "api_calls", "limit": 5000, "used": 5, "remaining": 4995, "requested": 1000000, "periodEnd": "2026-11-19T18:21:12.487Z" } } }
```

### GET /usage/history

Per-period totals, most recent first (at most 12 periods). `200`:
```json
{ "periods": [ { "periodStart": "2026-10-19T18:21:12.477Z", "isCurrent": true, "metrics": [ { "metric": "api_calls", "used": 6 } ] } ] }
```

### POST /demo/generate-report

Demonstrates server-side enforcement: metered by `enforceLimit('api_calls')`. The usage increment and the report are written in **one transaction** and commit together; any failure (including a failing commit) rolls both back and returns an error, never a success.

`201`:
```json
{ "report": { "id": "2cd91a77-…", "title": "Demo report #6", "generatedAt": "2026-10-19T18:21:12.619Z" },
  "usage": { "metric": "api_calls", "used": 6, "limit": 5000, "remaining": 4994, "unlimited": false } }
```
Errors: `402 SUBSCRIPTION_REQUIRED` / `SUBSCRIPTION_INACTIVE`, `429 LIMIT_EXCEEDED`.

## Billing

### GET /invoices

The caller's invoices, newest first. `status` is `paid`, `failed` or `refunded`; `kind` is `initial`, `upgrade_proration` or `renewal`. Zero-amount changes never create invoices.

`200`:
```json
{ "invoices": [ { "id": "b595be61-…", "subscriptionId": "de035929-…", "kind": "upgrade_proration", "status": "paid", "amountCents": 49900,
                  "description": "Upgrade from Free to Pro (prorated)", "billingPeriodStart": "2026-10-19T18:21:12.477Z", "createdAt": "2026-10-19T18:21:12.519Z" } ] }
```

### GET /billing/operations

Read-only list of the caller's payment attempts and refunds (newest first, at most 100), including attempts whose outcome is still unknown and refunds that **failed**. Provider references and idempotency keys are not exposed.

`200`:
```json
{ "operations": [ { "id": "d1df5e22-…", "type": "charge", "status": "succeeded", "kind": "upgrade", "amountCents": 49900, "attempt": 1,
                    "reason": null, "errorMessage": null, "invoiceId": "b595be61-…", "refundOfOperationId": null,
                    "createdAt": "2026-10-19T18:21:12.511Z", "updatedAt": "2026-10-19T18:21:12.519Z" } ] }
```
`type`: `charge` | `refund`. `status`: `pending` (outcome unknown; never counted as paid) | `succeeded` | `failed`. `kind`: `initial` | `upgrade` | `renewal` | `other`.

## Health

### GET /health

Public. `200 { "status": "ok", "database": "up", "time": "<server clock>" }`, or `503 { "status": "degraded", "database": "down", … }`.

## Development only

Mounted only when `NODE_ENV` is not `production` **and** `ENABLE_DEV_ENDPOINTS` is true. In production they are not registered (404) and `createApp` refuses to mount them. Both need a Bearer token.

### POST /dev/run-renewals

Runs one job cycle now (reconciliation, refunds, renewals, housekeeping) and returns its summary.

### POST /dev/advance-clock

Needs `FAKE_CLOCK=true` (otherwise `400`, `details.code: "FAKE_CLOCK_DISABLED"`; `FAKE_CLOCK` is rejected at startup in production). Body: exactly one of `{ "days": 31 }`, `{ "ms": 3600000 }`, `{ "to": "2026-12-01T00:00:00Z" }`; forward only. `200 { "before": "…", "now": "…" }`.

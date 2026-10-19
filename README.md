# SubCycle

Subscription lifecycle management: plans, proration, pause/resume, scheduled cancel/downgrade, usage limits and automated renewals, with a mock billing provider.

> **Status: Stages 1-4 complete** (foundation, auth, billing layer, subscription lifecycle). Usage limits, renewal/reconciliation jobs and the UI arrive in later stages. See [docs/SPEC.md](docs/SPEC.md), [docs/DECISIONS.md](docs/DECISIONS.md) and [docs/STATE_MACHINE.md](docs/STATE_MACHINE.md).

## Prerequisites

- Node.js 20+ and npm 10+
- Docker (Docker Desktop on Windows/macOS) for PostgreSQL

## Setup

```bash
npm install
cp .env.example .env        # placeholders match docker-compose.yml; edit if you change credentials
npm run db:up               # starts PostgreSQL 16 on localhost:5433 (databases: subcycle_dev, subcycle_test)
npm run db:migrate          # applies server/migrations/*.sql
npm run db:seed             # upserts the four plans (safe to run repeatedly)
npm run dev                 # API on :4000, web on :5173
```

Check it: `curl http://localhost:4000/health`.

## Scripts (repo root)

| Script | What it does |
|---|---|
| `npm run dev` | API (tsx watch) + web (Vite) together |
| `npm run build` | Compile server to `server/dist`, build client |
| `npm test` | Server tests (Vitest + Supertest) against `subcycle_test` |
| `npm run lint` | ESLint (type-aware for the server) |
| `npm run typecheck` | `tsc --noEmit` for server and client |
| `npm run db:up` / `db:down` | Start / stop the PostgreSQL container |
| `npm run db:migrate` | Apply pending migrations to `DATABASE_URL` |
| `npm run db:seed` | Upsert seed plans |
| `npm run db:reset` | **Drops** the `public` schema, re-migrates and re-seeds. Dev/test only. Refuses `NODE_ENV=production` and non-local hosts (unless `ALLOW_DB_RESET=true`) |

## API (so far)

All errors use `{ "error": { "code", "message", "details" } }`.

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health` | no | DB connectivity + server time |
| POST | `/auth/register` | no | `{ email, password (8–72 bytes), name }` → 201 `{ user, token, expiresAt }`; 409 `EMAIL_TAKEN`; 400 `VALIDATION_ERROR` |
| POST | `/auth/login` | no | `{ email, password }` → 200 `{ user, token, expiresAt }`; 401 `INVALID_CREDENTIALS` (same for unknown email and wrong password) |
| GET | `/auth/me` | Bearer | → `{ user }`; 401 `UNAUTHENTICATED` / `TOKEN_EXPIRED` |

| GET | `/plans` | no | Plans and limits |
| GET | `/subscriptions/current` | Bearer | Current (non-canceled) subscription incl. `accessAllowed`, `graceEndsAt`; 404 `SUBSCRIPTION_NOT_FOUND` |
| GET | `/subscriptions/history` | Bearer | Audit events, oldest first |
| GET | `/subscriptions/upgrade-preview?planId=` | Bearer | Prorated amount, never charges |
| POST | `/subscriptions` | Bearer | `{ planId }` subscribe (201). Paid plans are charged via the two-phase flow |
| POST | `/subscriptions/upgrade` | Bearer | `{ planId }` immediate, prorated |
| POST | `/subscriptions/downgrade` | Bearer | `{ planId }` scheduled for period end (replaces a pending one) |
| DELETE | `/subscriptions/pending-change` | Bearer | Remove the scheduled downgrade |
| POST | `/subscriptions/pause` / `resume` | Bearer | Resume extends the period by the paused time |
| POST | `/subscriptions/cancel` | Bearer | Schedules cancel at period end. In `past_due` keeps the 72 h grace; `{ "immediate": true }` (past_due only) cancels now |
| POST | `/subscriptions/reactivate` | Bearer | Undo a scheduled cancel |
| GET | `/invoices` | Bearer | The caller's invoices |

Errors: `400 VALIDATION_ERROR`, `401`, `402 PAYMENT_FAILED`, `404`, `409 INVALID_TRANSITION | OPERATION_IN_PROGRESS | STATE_CHANGED | REQUEST_IN_PROGRESS`, `422 IDEMPOTENCY_KEY_REUSED`.

**Idempotency-Key**: all `POST`/`DELETE` lifecycle endpoints accept an optional `Idempotency-Key` header (1-255 printable ASCII). A repeated identical request returns the original response with `Idempotent-Replay: true` and does not run again; the same key with a different request is a 422. A declined payment (402) is replayed for the same key, so retry with a new key. See [DECISIONS B7/B7a](docs/DECISIONS.md).

**Billing safety model**: every charge is a durable `billing_operations` row written *before* the provider is called (two-phase). If the outcome is unknown (timeout, crash, lost response) the attempt stays `pending`; it is resolved by looking the same idempotency key up at the provider, either on the user's retry or by `reconcilePendingOperations`. A new attempt/key is only created after a definitive failure. The provider is the mock in `server/src/billing/mockProvider.ts` (`MOCK_BILLING_FAIL=never|always|random:p`).

Send the token as `Authorization: Bearer <token>`. Tokens are HS256 JWTs (payload `sub`, `iat`, `exp` only), valid 1 h by default. `/auth/*` is rate limited per IP (default 20 / 15 min, `429 RATE_LIMITED`). Email is trimmed and lower-cased. Details and rationale: [docs/DECISIONS.md B14](docs/DECISIONS.md).

Auth environment variables: `JWT_SECRET` (**required, 32+ chars, in production**; dev/test fall back to a fixed non-secret value), `JWT_EXPIRES_IN_SECONDS`, `BCRYPT_COST`, `AUTH_RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_WINDOW_MS`.

## Database

- Plain SQL migrations in [server/migrations](server/migrations), applied in filename order by [server/src/db/migrate.ts](server/src/db/migrate.ts). Each file runs in its own transaction; applied files are recorded with a SHA-256 checksum in `schema_migrations`, and editing an applied file is an error (add a new migration instead). Forward-only.
- All SQL is parameterized; there is no ORM. Transactions go through `withTransaction` ([server/src/db/transaction.ts](server/src/db/transaction.ts)).
- Money is integer paise (INR). Timestamps are UTC `timestamptz`. Business time comes from the injected `Clock` ([server/src/lib/clock.ts](server/src/lib/clock.ts)); ESLint forbids `new Date()` / `Date.now()` elsewhere in `server/src`.
- Which invariants PostgreSQL enforces vs. the application: see [docs/DECISIONS.md §C](docs/DECISIONS.md).

### Seed plans

| code | name | interval | price | api_calls | projects | seats |
|---|---|---|---|---|---|---|
| free | Free | month | ₹0 | 100 | 1 | 1 |
| pro_monthly | Pro | month | ₹499 | 5,000 | 10 | 3 |
| business_monthly | Business | month | ₹1,499 | 50,000 | 100 | 25 |
| pro_yearly | Pro (Yearly) | year | ₹4,999 | 60,000 | 10 | 3 |

## Testing

`npm test` resets and migrates the **test** database (`TEST_DATABASE_URL`, whose name must end in `_test`) once, then runs test files serially, truncating data tables between tests. The migration tests use a throwaway database that they create and drop.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `failed to connect to the docker API` | Start Docker Desktop, wait until it reports running, retry `npm run db:up`. |
| `ECONNREFUSED 127.0.0.1:5433` | Container isn't up: `npm run db:up`; check `docker ps`. |
| Port 5433 already in use | Change the host port in `docker-compose.yml` and both URLs in `.env`. |
| `database "subcycle_test" does not exist` | The init script only runs on first volume creation. Run `docker compose down -v` then `npm run db:up` (this deletes local data). |
| `password authentication failed` | `.env` credentials differ from `docker-compose.yml`. They must match. |
| `Migration … was modified after being applied` | Never edit an applied migration. For local dev only, `npm run db:reset`. |
| `Refusing to reset …` | Intentional guard; see `db:reset` above. |

## Repository layout

```
client/   React + Vite + Tailwind (placeholder shell until Stage 7)
server/   Express + TypeScript API: migrations/, scripts/, src/{billing,controllers,db,jobs,lib,middleware,routes,services}, tests/
docs/     SPEC, DECISIONS, STATE_MACHINE
```

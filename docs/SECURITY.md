# Security review and checklist

Status: final review of v1. Every control below names the automated test that enforces it, so a regression fails CI.
Most checks live in [`server/tests/security.test.ts`](../server/tests/security.test.ts) (route inventory, authentication,
isolation, validation, CORS, error safety, production guards). Residual risks are listed at the end and in
[KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).

## How regressions are prevented

- **Route inventory test.** The list of routes is parsed from the source (`app.ts`, `routes/*.ts`). The test fails if a route exists without (a) a `###` section in [API.md](API.md) or (b) a public/bearer/dev classification in the test. A new endpoint therefore cannot ship unprotected or undocumented by accident.
- **Mutation-checked.** The protections below were deliberately broken to confirm the tests fail: removing `Cache-Control: no-store`, leaking an unscoped invoices query, deleting the production guard for `/dev`, and adding an undocumented route all turn the suite red. The same was done for the usage lock, the atomic limit check and `SKIP LOCKED`.

## Checklist

| Area | Control | Enforced by |
|---|---|---|
| **Authentication** | Every route except `GET /health`, `GET /plans`, `POST /auth/register`, `POST /auth/login` requires a valid Bearer JWT | `security.test.ts` › *authentication is required on every non-public route* (all protected routes, 401 + standard error shape) |
| | JWT: HS256 only (algorithm pinned), signature and expiry verified, `sub` must be a UUID, user must still exist; `alg:none`, HS512, wrong secret, expired, tampered payload/signature, junk and non-UUID `sub` are all rejected on every protected route | same › *every bad-token variant is rejected*; `auth.test.ts` |
| | Token accepted only from `Authorization: Bearer` (not query string, cookie or body); oversized headers are a clean 401 | same › *only accepted from the Authorization header* |
| | JWT secret from the environment; production refuses to start without a ≥ 32-character, non-default secret; never logged | `auth.test.ts` › *config for authentication*; `foundation.test.ts` › *does not echo secret values* |
| | Passwords hashed with bcrypt (cost 12, ≥ 10 enforced in production), 8–72 bytes (longer rejected, never silently truncated); constant-ish login timing; identical error for unknown email and wrong password | `auth.test.ts` (hashing, truncation, enumeration, timing dummy hash) |
| **Authorization / isolation** | Identity comes only from the token; no endpoint accepts a user or subscription id (strict bodies reject them) | `security.test.ts` › *lifecycle routes are keyed by the TOKEN* |
| | One user's reads never contain another's identifiers or data, on every GET route | › *B's reads never contain A's identifiers or data* |
| | One user's mutations (every lifecycle, usage and demo route) never change another's rows (full table snapshots compared) | › *B's mutations … never change A's rows* |
| | Idempotency keys are scoped per user: reusing another user's key neither replays nor collides | › *idempotency keys are per user*; `billingFlow.test.ts` |
| | All SQL is parameterized (no string-built SQL anywhere in `server/src`); metacharacters in inputs are data | › *SQL metacharacters … are data*; static audit (no `${}` inside SQL) |
| **Input validation** | Zod on every body and query; bodies are **strict** (unknown fields → 400, so no mass assignment); `__proto__`/`constructor` payloads, arrays, wrong types, malformed JSON, wrong content type, oversized body (100 kB → 413) | › *request validation* |
| | Quantities bounded (1–1,000,000 integers); metrics restricted to `^[a-z][a-z0-9_]{0,62}$` and to the plan | `usage.test.ts` |
| **Error safety** | One error shape everywhere; 500s are always the generic body; no stack traces, SQL, provider messages or secrets, even when the database fails (every authenticated route tested with a failing database that tries to leak) | › *every error response has the standard shape … even when the database fails* |
| | Logs contain no passwords, tokens, hashes or request bodies | `auth.test.ts` › *never logs passwords, tokens or hashes* |
| **CORS** | Explicit allow-list (no wildcard), no credentials, only the needed methods/headers; unknown origins and `Origin: null` get no CORS headers; production must set `CORS_ORIGINS` explicitly | › *CORS*; › *config forces dev endpoints off … requires an explicit CORS allow-list in production* |
| **Rate limiting** | Strict per-IP limiter on `POST /auth/register` and `POST /auth/login` (shared bucket); generous per-**user** limiter on `/auth/me`, `/usage*`, `/demo/*`; distinct from plan limits (`429 LIMIT_EXCEEDED`) | › *rate limiting*; `auth.test.ts`; `usage.test.ts` |
| **Idempotency** | Per-user keys; replay returns the original response; different request → 422; in-progress → 409; 5xx/transient results never stored; abandoned requests recoverable; expired keys purged by the job cycle | `billingFlow.test.ts` › *HTTP Idempotency-Key*; `security.test.ts` › *housekeeping* |
| **Dev endpoints** | `/dev/run-renewals` and `/dev/advance-clock` are impossible to enable in production: config forces them off (`FAKE_CLOCK` is a startup error too), `createApp` throws if asked to mount them, and a real process started with `NODE_ENV=production ENABLE_DEV_ENDPOINTS=true` serves 404 for both. They also require authentication | › *development routes can never be enabled in production* (including spawned server processes) |
| **Transport / headers** | `helmet` defaults (nosniff, frame options, HSTS, …), `X-Powered-By` removed, `Cache-Control: no-store` on every response (personal and billing data) | › *response headers and error safety* |
| **Billing safety** | No double charge on retries, crashes or concurrent requests; unknown outcomes resolved via the original provider key; compensating refunds recorded durably | `billingFlow.test.ts`, `billingConcurrency.test.ts`, `renewal.test.ts` |
| **Frontend (XSS)** | React renders all API data as text; the lint config **forbids** `dangerouslySetInnerHTML`, `innerHTML` assignment, `insertAdjacentHTML`, `eval`, `new Function`, `javascript:` URLs; a test renders hostile plan names, event data, errors and names and asserts they appear as text with no injected elements; post-login redirects accept same-site paths only | `eslint.config.js` (CI lint step); `client/tests/security.test.tsx` |
| **Frontend (session)** | Token in `localStorage` (documented trade-off); expired or rejected sessions return to login without crashing; a network failure never logs the user out | `client/tests/auth.test.tsx`; [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) |
| **Test environment** | jsdom "not implemented" errors (e.g. an accidental hard navigation) now fail the test that causes them | `client/tests/setup.ts` |
| **Supply chain / secrets** | `npm audit` clean (CI runs `--omit=dev --audit-level=high`); lockfiles committed and installed with `npm ci`; `.env` ignored, only placeholders in `.env.example`; no secrets in the repository (the docker password is a local-only dev value and the database port is bound to `127.0.0.1`) | CI workflow; static audit |

## Recommended production deployment settings (not enforced by the app)

- **TLS** terminates at the edge; send HSTS from there. Serve the built web app and the API from the same site (the `/api` proxy) or list the exact web origin in `CORS_ORIGINS`.
- **Content-Security-Policy** for the static web app (it uses a Tailwind stylesheet file, inline `style` attributes for progress bars, and a `data:` favicon):
  `default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`
  (if the API is on another origin, add it to `connect-src`). Also send `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
- **Trust proxy.** The per-IP login limiter uses `req.ip`. Behind a reverse proxy or load balancer every client appears as the proxy unless `TRUST_PROXY` is set. It is **off by default** and accepts only a hop count (1 to 5, for example `1` on Render), never `true`, because trusting every hop would let a client choose its own rate-limit key by sending `X-Forwarded-For`. Tests (`server/tests/trustProxy.test.ts`) simulate the proxy header; the hop count has not been verified against Render's real network until the post-deploy check in [DEPLOYMENT.md](DEPLOYMENT.md).
- **Database role.** Run the API with a role that owns only its schema (not a superuser); keep `ALLOW_DB_RESET` unset; take backups.
- **Secrets.** Provide `JWT_SECRET` (≥ 32 random characters, rotated on suspicion of leak; rotation invalidates all sessions), `DATABASE_URL`, `CORS_ORIGINS` through the platform's secret store.

## Residual risks (accepted for v1)

1. **JWT in `localStorage`.** Any script that runs on the page can read it, so the app depends on staying free of XSS (mitigated by text-only rendering, lint bans and a CSP). Tokens live 1 hour; there is no refresh token and **no server-side revocation or logout** (signing out only deletes the token in the browser). An `HttpOnly` cookie with CSRF protection would remove this class of risk.
2. **Registration reveals whether an email exists** (409 `EMAIL_TAKEN`); login does not.
3. **Rate limiters are in-memory per process** and the login limiter keys on IP (see trust proxy above; set `TRUST_PROXY` behind a proxy). Multiple API processes each keep their own counters.
4. **Mock billing only.** No card data is handled at all in v1; a real provider needs webhook verification, PCI scoping and the checklist items above re-reviewed.
5. **No operator audit or alerting.** Failed refunds and stuck payment operations are visible to the affected user and in the job log, but there is no operator-wide view or alert.
6. **Single-factor authentication, no account lockout beyond rate limiting, no email verification or password reset.**

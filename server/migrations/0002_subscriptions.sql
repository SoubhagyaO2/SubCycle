-- Subscriptions: one non-canceled row per user. Lifecycle invariants are enforced by CHECKs
-- so that application bugs cannot persist an impossible combination of fields.

CREATE TABLE subscriptions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  plan_id               uuid        NOT NULL REFERENCES plans (id) ON DELETE RESTRICT,
  pending_plan_id       uuid        REFERENCES plans (id) ON DELETE RESTRICT,
  status                text        NOT NULL,
  current_period_start  timestamptz NOT NULL,
  current_period_end    timestamptz NOT NULL,
  cancel_at_period_end  boolean     NOT NULL DEFAULT false,
  cancel_requested_at   timestamptz,
  paused_at             timestamptz,
  canceled_at           timestamptz,
  cancel_reason         text,
  past_due_since        timestamptz,
  retry_count           integer     NOT NULL DEFAULT 0,
  next_retry_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT subscriptions_status_valid CHECK (status IN ('active', 'paused', 'past_due', 'canceled')),
  CONSTRAINT subscriptions_period_order CHECK (current_period_end > current_period_start),
  CONSTRAINT subscriptions_retry_count_range CHECK (retry_count BETWEEN 0 AND 3),
  CONSTRAINT subscriptions_pending_differs CHECK (pending_plan_id IS NULL OR pending_plan_id <> plan_id),
  CONSTRAINT subscriptions_cancel_reason_valid CHECK (cancel_reason IS NULL OR cancel_reason IN ('user_requested', 'payment_failed')),
  -- A scheduled cancellation always records when it was requested.
  CONSTRAINT subscriptions_cancel_flag_has_request CHECK (NOT cancel_at_period_end OR cancel_requested_at IS NOT NULL),
  -- Status-dependent fields.
  CONSTRAINT subscriptions_paused_at_iff_paused CHECK ((status = 'paused') = (paused_at IS NOT NULL)),
  CONSTRAINT subscriptions_past_due_since_iff_past_due CHECK ((status = 'past_due') = (past_due_since IS NOT NULL)),
  CONSTRAINT subscriptions_canceled_fields CHECK (
    (status = 'canceled') = (canceled_at IS NOT NULL)
    AND (status = 'canceled') = (cancel_reason IS NOT NULL)
  ),
  CONSTRAINT subscriptions_retry_fields_only_past_due CHECK (
    status = 'past_due' OR (next_retry_at IS NULL AND retry_count = 0)
  )
);

-- At most one non-canceled subscription per user.
CREATE UNIQUE INDEX subscriptions_one_open_per_user ON subscriptions (user_id) WHERE status <> 'canceled';

CREATE INDEX subscriptions_user_idx ON subscriptions (user_id, created_at DESC);
-- Renewal job: active subscriptions whose period has ended.
CREATE INDEX subscriptions_renewal_due_idx ON subscriptions (current_period_end) WHERE status = 'active';
-- Retry job: past_due subscriptions by next retry (also covers user-requested cancels in past_due).
CREATE INDEX subscriptions_past_due_retry_idx ON subscriptions (next_retry_at) WHERE status = 'past_due';

-- Audit events, usage metering, and HTTP-level idempotency keys.

CREATE TABLE subscription_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid        NOT NULL REFERENCES subscriptions (id) ON DELETE RESTRICT,
  type            text        NOT NULL,
  from_status     text,
  to_status       text,
  meta            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL,   -- set from the application Clock, not DB now()
  CONSTRAINT subscription_events_type_valid CHECK (type IN (
    'subscribed', 'upgraded', 'downgrade_scheduled', 'downgrade_cleared', 'downgrade_applied',
    'paused', 'resumed', 'cancel_scheduled', 'reactivated', 'renewed', 'renewal_failed', 'canceled',
    'charge_discarded'
  )),
  CONSTRAINT subscription_events_from_status_valid CHECK (from_status IS NULL OR from_status IN ('active', 'paused', 'past_due', 'canceled')),
  CONSTRAINT subscription_events_to_status_valid CHECK (to_status IS NULL OR to_status IN ('active', 'paused', 'past_due', 'canceled')),
  CONSTRAINT subscription_events_meta_is_object CHECK (jsonb_typeof(meta) = 'object')
);
CREATE INDEX subscription_events_subscription_idx ON subscription_events (subscription_id, created_at, id);

CREATE TABLE usage_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid        NOT NULL REFERENCES subscriptions (id) ON DELETE RESTRICT,
  metric          text        NOT NULL,
  period_start    timestamptz NOT NULL,
  quantity        bigint      NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usage_records_quantity_nonnegative CHECK (quantity >= 0),
  CONSTRAINT usage_records_metric_not_blank CHECK (length(trim(metric)) > 0),
  -- Required target of the atomic INSERT ... ON CONFLICT DO UPDATE increment; also the lookup index.
  CONSTRAINT usage_records_unique_period UNIQUE (subscription_id, metric, period_start)
);

-- HTTP Idempotency-Key storage (docs/DECISIONS.md B7). Separate from provider-level idempotency.
CREATE TABLE idempotency_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key             text        NOT NULL,
  request_method  text        NOT NULL,
  request_path    text        NOT NULL,
  request_hash    text        NOT NULL,
  status          text        NOT NULL DEFAULT 'in_progress',
  locked_until    timestamptz NOT NULL,   -- an in_progress row past this instant is abandoned and may be taken over
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  CONSTRAINT idempotency_keys_user_key_unique UNIQUE (user_id, key),
  CONSTRAINT idempotency_keys_status_valid CHECK (status IN ('in_progress', 'completed')),
  CONSTRAINT idempotency_keys_key_length CHECK (length(key) BETWEEN 1 AND 255),
  CONSTRAINT idempotency_keys_completed_has_response CHECK (status <> 'completed' OR response_status IS NOT NULL)
);
CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys (expires_at);

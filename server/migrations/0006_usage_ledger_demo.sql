-- Usage ledger (one row per consumption, written in the SAME transaction as the counter update) and the demo
-- endpoint's metered work. See docs/DECISIONS.md B13a.

CREATE TABLE usage_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid        NOT NULL REFERENCES subscriptions (id) ON DELETE RESTRICT,
  metric          text        NOT NULL,
  period_start    timestamptz NOT NULL,
  quantity        bigint      NOT NULL,
  source          text        NOT NULL,
  request_key     text,                       -- client Idempotency-Key for exactly-once recording; NULL if none
  created_at      timestamptz NOT NULL,       -- application Clock
  CONSTRAINT usage_events_quantity_positive CHECK (quantity > 0),
  CONSTRAINT usage_events_metric_not_blank CHECK (length(trim(metric)) > 0),
  CONSTRAINT usage_events_source_valid CHECK (source IN ('api', 'demo')),
  CONSTRAINT usage_events_request_key_length CHECK (request_key IS NULL OR length(request_key) BETWEEN 1 AND 255)
);

-- A retry with the same key can never be recorded twice, even across crashes.
CREATE UNIQUE INDEX usage_events_request_key_unique ON usage_events (subscription_id, request_key) WHERE request_key IS NOT NULL;
CREATE INDEX usage_events_period_idx ON usage_events (subscription_id, metric, period_start);

-- The demo endpoint's "work": each report is committed atomically with exactly one usage event.
CREATE TABLE demo_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  subscription_id uuid        NOT NULL REFERENCES subscriptions (id) ON DELETE RESTRICT,
  usage_event_id  uuid        NOT NULL REFERENCES usage_events (id) ON DELETE RESTRICT,
  title           text        NOT NULL,
  created_at      timestamptz NOT NULL,
  CONSTRAINT demo_reports_usage_event_unique UNIQUE (usage_event_id)
);
CREATE INDEX demo_reports_user_idx ON demo_reports (user_id, created_at);

-- Events written by the application Clock can share a timestamp (several events in one transaction, or a coarse
-- or fake clock). A monotonically increasing sequence gives history a stable, insertion-ordered tiebreaker.

ALTER TABLE subscription_events ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;

DROP INDEX subscription_events_subscription_idx;
CREATE INDEX subscription_events_subscription_idx ON subscription_events (subscription_id, created_at, seq);

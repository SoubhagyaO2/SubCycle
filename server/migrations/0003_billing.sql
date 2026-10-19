-- Invoices (one per billing obligation) and billing_operations (one per payment attempt).
--
-- Identity model (docs/DECISIONS.md B7/B8):
--   obligation_key   = the logical thing being charged; stable across retries.
--   idempotency_key  = one payment attempt of an obligation: charge:{obligation_key}:attempt:{n}.

CREATE TABLE invoices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id       uuid        NOT NULL REFERENCES subscriptions (id) ON DELETE RESTRICT,
  plan_id               uuid        NOT NULL REFERENCES plans (id) ON DELETE RESTRICT, -- plan billed; informational
  obligation_key        text        NOT NULL,
  kind                  text        NOT NULL,
  status                text        NOT NULL,
  amount_cents          integer     NOT NULL,
  description           text        NOT NULL,
  billing_period_start  timestamptz NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoices_obligation_key_unique UNIQUE (obligation_key),
  CONSTRAINT invoices_kind_valid CHECK (kind IN ('renewal', 'upgrade_proration', 'initial')),
  CONSTRAINT invoices_status_valid CHECK (status IN ('paid', 'failed', 'refunded')),
  -- Zero-amount changes are audited through subscription_events, never invoiced.
  CONSTRAINT invoices_amount_positive CHECK (amount_cents > 0)
);

-- A subscription's renewal for a given period exists at most once.
CREATE UNIQUE INDEX invoices_one_renewal_per_period ON invoices (subscription_id, billing_period_start) WHERE kind = 'renewal';
CREATE INDEX invoices_subscription_idx ON invoices (subscription_id, created_at DESC);

CREATE TABLE billing_operations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  subscription_id         uuid        REFERENCES subscriptions (id) ON DELETE RESTRICT, -- NULL until an initial subscription exists
  invoice_id              uuid        REFERENCES invoices (id) ON DELETE RESTRICT,
  obligation_key          text        NOT NULL,
  attempt                 integer     NOT NULL,
  idempotency_key         text        NOT NULL,
  operation_type          text        NOT NULL,
  refund_of_operation_id  uuid        REFERENCES billing_operations (id) ON DELETE RESTRICT,
  reason                  text,                         -- e.g. 'state_changed' for compensation refunds
  amount_cents            integer     NOT NULL,
  status                  text        NOT NULL DEFAULT 'pending',
  provider_reference      text,
  error_message           text,
  meta                    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  resolve_attempts        integer     NOT NULL DEFAULT 0,  -- reconciliation bookkeeping
  last_checked_at         timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_operations_idempotency_key_unique UNIQUE (idempotency_key),
  CONSTRAINT billing_operations_attempt_unique UNIQUE (obligation_key, operation_type, attempt),
  CONSTRAINT billing_operations_type_valid CHECK (operation_type IN ('charge', 'refund')),
  CONSTRAINT billing_operations_status_valid CHECK (status IN ('pending', 'succeeded', 'failed')),
  CONSTRAINT billing_operations_amount_positive CHECK (amount_cents > 0),
  CONSTRAINT billing_operations_attempt_positive CHECK (attempt >= 1),
  CONSTRAINT billing_operations_meta_is_object CHECK (jsonb_typeof(meta) = 'object'),
  CONSTRAINT billing_operations_refund_link CHECK ((operation_type = 'refund') = (refund_of_operation_id IS NOT NULL))
);

-- At most one in-flight charge per obligation: concurrent requests cannot create two attempts.
CREATE UNIQUE INDEX billing_operations_one_pending_charge ON billing_operations (obligation_key)
  WHERE operation_type = 'charge' AND status = 'pending';
-- At most one refund per charge (compensation is idempotent).
CREATE UNIQUE INDEX billing_operations_one_refund_per_charge ON billing_operations (refund_of_operation_id)
  WHERE operation_type = 'refund';
-- Reconciliation / refund processor scan.
CREATE INDEX billing_operations_pending_idx ON billing_operations (created_at) WHERE status = 'pending';
CREATE INDEX billing_operations_subscription_idx ON billing_operations (subscription_id);
CREATE INDEX billing_operations_user_idx ON billing_operations (user_id);
CREATE INDEX billing_operations_invoice_idx ON billing_operations (invoice_id);

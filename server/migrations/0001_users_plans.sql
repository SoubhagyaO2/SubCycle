-- Users and plans. All money is integer paise; all timestamps are timestamptz (UTC).

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text        NOT NULL,
  password_hash text        NOT NULL,
  name          text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_lowercase CHECK (email = lower(email)),
  CONSTRAINT users_email_not_blank CHECK (length(trim(email)) > 0),
  CONSTRAINT users_email_unique UNIQUE (email)
);

CREATE TABLE plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text        NOT NULL,
  name        text        NOT NULL,
  price_cents integer     NOT NULL,
  interval    text        NOT NULL,
  limits      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plans_code_unique UNIQUE (code),
  CONSTRAINT plans_price_nonnegative CHECK (price_cents >= 0),
  CONSTRAINT plans_interval_valid CHECK (interval IN ('month', 'year')),
  CONSTRAINT plans_limits_is_object CHECK (jsonb_typeof(limits) = 'object')
);

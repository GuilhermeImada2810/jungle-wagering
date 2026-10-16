DROP TABLE IF EXISTS inbox_messages, outbox_messages CASCADE;

CREATE TABLE inbox_messages (
  consumer_name  text NOT NULL,
  message_id     text NOT NULL,
  payload_hash   text NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  processed_at   timestamptz,

  PRIMARY KEY (consumer_name, message_id)
);

CREATE TABLE outbox_messages (
  id               uuid PRIMARY KEY,
  aggregate_id     uuid NOT NULL,
  event_type       text NOT NULL,
  payload          jsonb NOT NULL,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz,
  published_at     timestamptz,

  CONSTRAINT ob_attempts_ck CHECK (attempts >= 0),
  CONSTRAINT ob_payload_ck CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX ob_pending_idx
  ON outbox_messages (next_attempt_at NULLS FIRST, occurred_at)
  WHERE published_at IS NULL;

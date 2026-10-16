DROP TABLE IF EXISTS wallet_ledger_entries, wager_transactions, wallets CASCADE;
DROP FUNCTION IF EXISTS wle_forbid_mutation();

CREATE TABLE wallets (
  id          uuid PRIMARY KEY,
  player_id   uuid NOT NULL,
  currency    char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  balance     numeric(18,2) NOT NULL CHECK (balance >= 0),
  version     integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallets_player_currency_uq UNIQUE (player_id, currency)
);

CREATE TABLE wager_transactions (
  id                                uuid PRIMARY KEY,
  provider_id                       text NOT NULL,
  external_transaction_id           text NOT NULL,
  idempotency_key                   text NOT NULL,
  payload_hash                      text NOT NULL,
  wallet_id                         uuid NOT NULL REFERENCES wallets(id),
  player_id                         uuid NOT NULL,
  round_id                          text NOT NULL,
  game_id                           text NOT NULL,
  kind                              text NOT NULL,
  amount                            numeric(18,2) NOT NULL,
  currency                          char(3) NOT NULL,
  reference_external_transaction_id text,
  reference_transaction_id          uuid REFERENCES wager_transactions(id),
  status                            text NOT NULL,
  failure_code                      text,
  balance_after                     numeric(18,2),
  created_at                        timestamptz NOT NULL DEFAULT now(),
  processed_at                      timestamptz,

  CONSTRAINT wt_external_uq UNIQUE (provider_id, external_transaction_id),
  CONSTRAINT wt_idempotency_uq UNIQUE (provider_id, idempotency_key),
  CONSTRAINT wt_kind_ck CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  CONSTRAINT wt_status_ck CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  CONSTRAINT wt_amount_ck CHECK (amount >= 0),
  CONSTRAINT wt_currency_ck CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT wt_reference_ck CHECK (
    (kind IN ('REFUND','ROLLBACK')) = (reference_external_transaction_id IS NOT NULL)
  ),
  CONSTRAINT wt_failure_ck CHECK (
    (status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)
  ),
  CONSTRAINT wt_processed_ck CHECK (
    (status = 'PROCESSED') = (processed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX wt_single_reversal_uq
  ON wager_transactions (reference_transaction_id, kind)
  WHERE status = 'PROCESSED' AND reference_transaction_id IS NOT NULL;

CREATE TABLE wallet_ledger_entries (
  id              uuid PRIMARY KEY,
  wallet_id       uuid NOT NULL REFERENCES wallets(id),
  transaction_id  uuid NOT NULL REFERENCES wager_transactions(id),
  direction       text NOT NULL,
  amount          numeric(18,2) NOT NULL,
  balance_before  numeric(18,2) NOT NULL,
  balance_after   numeric(18,2) NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT wle_tx_wallet_uq UNIQUE (transaction_id, wallet_id),
  CONSTRAINT wle_direction_ck CHECK (direction IN ('DEBIT','CREDIT')),
  CONSTRAINT wle_amount_ck CHECK (amount > 0),
  CONSTRAINT wle_balances_ck CHECK (balance_before >= 0 AND balance_after >= 0),
  CONSTRAINT wle_balanced_ck CHECK (
    (direction = 'CREDIT' AND balance_after = balance_before + amount)
    OR
    (direction = 'DEBIT'  AND balance_after = balance_before - amount)
  )
);

CREATE FUNCTION wle_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'wallet_ledger_entries é append-only: % não é permitido', TG_OP;
END;
$$;

CREATE TRIGGER wle_no_update_delete
  BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION wle_forbid_mutation();

CREATE TRIGGER wle_no_truncate
  BEFORE TRUNCATE ON wallet_ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION wle_forbid_mutation();

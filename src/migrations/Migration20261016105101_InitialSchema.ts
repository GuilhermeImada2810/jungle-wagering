import { Migration } from '@mikro-orm/migrations';

export class Migration20261016105101_InitialSchema extends Migration {
  override name = 'Migration20261016105101_InitialSchema';

  override async up(): Promise<void> {
    this.addSql(`
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
    `);

    this.addSql(`
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
    `);

    this.addSql(`
      CREATE UNIQUE INDEX wt_single_reversal_uq
        ON wager_transactions (reference_transaction_id, kind)
        WHERE status = 'PROCESSED' AND reference_transaction_id IS NOT NULL;
    `);

    this.addSql(`
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
    `);

    this.addSql(`
      CREATE FUNCTION wle_forbid_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only: % not allowed', TG_OP;
      END;
      $fn$;
    `);

    this.addSql(`
      CREATE TRIGGER wle_no_update_delete
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION wle_forbid_mutation();
    `);

    this.addSql(`
      CREATE TRIGGER wle_no_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION wle_forbid_mutation();
    `);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name  text NOT NULL,
        message_id     text NOT NULL,
        payload_hash   text NOT NULL,
        received_at    timestamptz NOT NULL DEFAULT now(),
        processed_at   timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    this.addSql(`
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
    `);

    this.addSql(`
      CREATE INDEX ob_pending_idx
        ON outbox_messages (next_attempt_at NULLS FIRST, occurred_at)
        WHERE published_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS outbox_messages;');
    this.addSql('DROP TABLE IF EXISTS inbox_messages;');
    this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries;');
    this.addSql('DROP FUNCTION IF EXISTS wle_forbid_mutation();');
    this.addSql('DROP TABLE IF EXISTS wager_transactions;');
    this.addSql('DROP TABLE IF EXISTS wallets;');
  }
}

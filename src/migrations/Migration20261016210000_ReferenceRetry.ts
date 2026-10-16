import { Migration } from '@mikro-orm/migrations';

export class Migration20261016210000_ReferenceRetry extends Migration {
  override name = 'Migration20261016210000_ReferenceRetry';

  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD COLUMN reference_attempts integer NOT NULL DEFAULT 0,
        ADD COLUMN reference_next_attempt_at timestamptz;
    `);
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD CONSTRAINT wt_ref_attempts_ck CHECK (reference_attempts >= 0);
    `);
    this.addSql(`
      CREATE INDEX wt_pending_ref_idx
        ON wager_transactions (reference_next_attempt_at NULLS FIRST, created_at)
        WHERE status = 'PENDING_REFERENCE';
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP INDEX IF EXISTS wt_pending_ref_idx;');
    this.addSql('ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS wt_ref_attempts_ck;');
    this.addSql(`
      ALTER TABLE wager_transactions
        DROP COLUMN IF EXISTS reference_next_attempt_at,
        DROP COLUMN IF EXISTS reference_attempts;
    `);
  }
}

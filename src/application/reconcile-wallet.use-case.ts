import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { Money, type MoneyProps } from '../domain/money.js';
import { PG_POOL } from '../infrastructure/database/database.module.js';

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

@Injectable()
export class ReconcileWalletUseCase {
  private readonly logger = new Logger(ReconcileWalletUseCase.name);
  divergences = 0;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async execute(walletId: string): Promise<ReconciliationResult | undefined> {
    // Uma unica consulta (snapshot consistente): saldo e ledger lidos juntos.
    const r = await this.pool.query(
      `SELECT w.currency,
              w.balance::text AS stored,
              COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END), 0)::text AS calculated,
              COUNT(e.id)::int AS entries
         FROM wallets w
         LEFT JOIN wallet_ledger_entries e ON e.wallet_id = w.id
        WHERE w.id = $1
        GROUP BY w.id`,
      [walletId],
    );
    const row = r.rows[0];
    if (!row) return undefined;

    const currency = (row.currency as string).trim();
    const stored = Money.from({ amount: row.stored, currency });
    const calculated = Money.from({ amount: row.calculated, currency });
    const difference = stored.subtract(calculated);
    const consistent = difference.isZero();

    if (!consistent) {
      this.divergences += 1;
      this.logger.error(
        JSON.stringify({
          event: 'reconciliation_divergence',
          walletId,
          difference: difference.toString(),
          checkedEntries: row.entries,
        }),
      );
    }

    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: row.entries as number,
    };
  }
}

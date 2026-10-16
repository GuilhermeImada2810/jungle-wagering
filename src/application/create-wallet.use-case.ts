import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { Money, type MoneyProps } from '../domain/money.js';
import { PG_POOL } from '../infrastructure/database/database.module.js';
import { withTransaction } from '../infrastructure/database/transaction.js';

export class WalletAlreadyExistsError extends Error {
  constructor() {
    super('ja existe wallet para este playerId e moeda');
    this.name = 'WalletAlreadyExistsError';
  }
}

export interface CreateWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

@Injectable()
export class CreateWalletUseCase {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async execute(input: CreateWalletInput): Promise<WalletView> {
    const initial = Money.from(input.initialBalance);
    const walletId = randomUUID();
    const now = new Date();

    return withTransaction(this.pool, async (db) => {
      const inserted = await db.query(
        `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 1, $5, $5)
         ON CONFLICT (player_id, currency) DO NOTHING
         RETURNING id`,
        [walletId, input.playerId, initial.currency, initial.toString(), now],
      );
      if (inserted.rowCount === 0) {
        throw new WalletAlreadyExistsError();
      }

      if (initial.isPositive()) {
        const txId = randomUUID();
        const entryId = randomUUID();
        const zero = Money.zero(initial.currency);

        await db.query(
          `INSERT INTO wager_transactions
             (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
              wallet_id, player_id, round_id, game_id, kind, amount, currency,
              status, balance_after, created_at, processed_at)
           VALUES ($1, 'SYSTEM', $2, $2, $3, $4, $5, 'opening', 'opening', 'OPENING',
                   $6, $7, 'PROCESSED', $6, $8, $8)`,
          [
            txId,
            `opening:${walletId}`,
            'opening',
            walletId,
            input.playerId,
            initial.toString(),
            initial.currency,
            now,
          ],
        );

        await db.query(
          `INSERT INTO wallet_ledger_entries
             (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after, created_at)
           VALUES ($1, $2, $3, 'CREDIT', $4, $5, $4, $6)`,
          [entryId, walletId, txId, initial.toString(), zero.toString(), now],
        );

        const event = {
          eventId: randomUUID(),
          eventType: 'WalletBalanceChanged',
          aggregateId: walletId,
          correlationId: txId,
          occurredAt: now.toISOString(),
          version: 1,
          data: {
            walletId,
            transactionId: txId,
            direction: 'CREDIT',
            money: initial.toJSON(),
            balanceBefore: zero.toJSON(),
            balanceAfter: initial.toJSON(),
            walletVersion: 1,
          },
        };
        await db.query(
          `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [event.eventId, walletId, event.eventType, JSON.stringify(event), now],
        );
      }

      return {
        id: walletId,
        playerId: input.playerId,
        balance: initial.toJSON(),
        version: 1,
      };
    });
  }
}

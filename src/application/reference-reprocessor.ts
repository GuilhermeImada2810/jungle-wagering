import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { FailureCode } from '../domain/failure-code.js';
import { Money } from '../domain/money.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction.js';
import { Wallet } from '../domain/wallet.js';
import { PG_POOL } from '../infrastructure/database/database.module.js';
import { withTransaction } from '../infrastructure/database/transaction.js';
import { applyWalletEffects, emitTransactionEvents } from './persistence-helpers.js';
import { resolveReversal } from './reversal.js';

export interface ReprocessResult {
  processed: number;
  rejected: number;
  stillPending: number;
}

/**
 * Reprocessa REFUND/ROLLBACK cuja referencia ainda nao existia.
 * Backoff exponencial (5s * 2^tentativas, teto 10 min). Limite de tentativas
 * (padrao 8, ~10 min no total ate o teto) esgotado: REJECTED REFERENCE_NOT_FOUND.
 */
@Injectable()
export class ReferenceReprocessor {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async processDue(
    limit = 50,
    maxAttempts = Number(process.env.REFERENCE_MAX_ATTEMPTS ?? 8),
  ): Promise<ReprocessResult> {
    const due = await this.pool.query(
      `SELECT id, wallet_id FROM wager_transactions
        WHERE status = 'PENDING_REFERENCE'
          AND (reference_next_attempt_at IS NULL OR reference_next_attempt_at <= now())
        ORDER BY created_at
        LIMIT $1`,
      [limit],
    );
    const out: ReprocessResult = { processed: 0, rejected: 0, stillPending: 0 };
    for (const d of due.rows) {
      const r = await withTransaction(this.pool, (db) =>
        this.processOne(db, d.id as string, d.wallet_id as string, maxAttempts),
      );
      if (r === 'processed') out.processed += 1;
      else if (r === 'rejected') out.rejected += 1;
      else if (r === 'pending') out.stillPending += 1;
    }
    return out;
  }

  private async processOne(
    db: PoolClient,
    id: string,
    walletId: string,
    maxAttempts: number,
  ): Promise<'processed' | 'rejected' | 'pending' | 'skipped'> {
    // Ordem de locks igual a do use case: wallet primeiro, depois a transacao.
    const w = await db.query(
      `SELECT id, player_id, currency, balance, version, created_at, updated_at
         FROM wallets WHERE id = $1 FOR UPDATE`,
      [walletId],
    );
    const t = await db.query(
      `SELECT id, provider_id, external_transaction_id, idempotency_key, payload_hash,
              wallet_id, player_id, round_id, game_id, kind, amount::text AS amount, currency,
              reference_external_transaction_id, reference_attempts, status, created_at
         FROM wager_transactions WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const wr = w.rows[0];
    const tr = t.rows[0];
    if (!wr || !tr || tr.status !== WagerTransactionStatus.PendingReference) return 'skipped';

    const now = new Date();
    const wallet = Wallet.rehydrate({
      id: wr.id,
      playerId: wr.player_id,
      currency: wr.currency,
      balance: Money.from({ amount: wr.balance, currency: wr.currency }),
      version: wr.version,
      createdAt: wr.created_at,
      updatedAt: wr.updated_at,
    });
    const previousVersion = wallet.version;
    const tx = WagerTransaction.rehydrate({
      id: tr.id,
      providerId: tr.provider_id,
      externalTransactionId: tr.external_transaction_id,
      idempotencyKey: tr.idempotency_key,
      payloadHash: tr.payload_hash,
      walletId: tr.wallet_id,
      playerId: tr.player_id,
      roundId: tr.round_id,
      gameId: tr.game_id,
      kind: tr.kind as WagerTransactionKind,
      money: Money.from({ amount: tr.amount, currency: String(tr.currency).trim() }),
      referenceExternalTransactionId: tr.reference_external_transaction_id,
      createdAt: tr.created_at,
      status: tr.status as WagerTransactionStatus,
    });

    const { entry } = await resolveReversal(db, wallet, tx, now);
    const attempts = (tr.reference_attempts as number) + 1;

    if (tx.status === WagerTransactionStatus.PendingReference) {
      if (attempts < maxAttempts) {
        const delay = Math.min(5 * 2 ** attempts, 600);
        await db.query(
          `UPDATE wager_transactions
              SET reference_attempts = $2,
                  reference_next_attempt_at = now() + ($3 || ' seconds')::interval
            WHERE id = $1`,
          [id, attempts, String(delay)],
        );
        return 'pending';
      }
      tx.reject(FailureCode.ReferenceNotFound);
    }

    await db.query(
      `UPDATE wager_transactions
          SET status = $2, failure_code = $3, reference_transaction_id = $4,
              balance_after = $5, processed_at = $6, reference_attempts = $7,
              reference_next_attempt_at = NULL
        WHERE id = $1`,
      [
        id,
        tx.status,
        tx.failureCode ?? null,
        tx.referenceTransactionId ?? null,
        wallet.balance.toString(),
        tx.processedAt ?? null,
        attempts,
      ],
    );
    if (entry) await applyWalletEffects(db, wallet, previousVersion, entry, now);
    await emitTransactionEvents(db, tx, wallet, entry, now);
    return tx.status === WagerTransactionStatus.Processed ? 'processed' : 'rejected';
  }
}

import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { FailureCode } from '../domain/failure-code.js';
import { Money } from '../domain/money.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction.js';
import { InsufficientFundsError, type Wallet } from '../domain/wallet.js';
import { LedgerDirection, type WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';

/**
 * Resolve um REFUND/ROLLBACK. PRECISA ser chamada com a wallet ja travada (FOR UPDATE).
 * Muta `tx` (PROCESSED, REJECTED ou PENDING_REFERENCE) e `wallet` (se aplicou saldo).
 */
export async function resolveReversal(
  db: PoolClient,
  wallet: Wallet,
  tx: WagerTransaction,
  now: Date,
): Promise<{ entry?: WalletLedgerEntry }> {
  const r = await db.query(
    `SELECT id, provider_id, external_transaction_id, idempotency_key, payload_hash,
            wallet_id, player_id, round_id, game_id, kind, amount::text AS amount,
            currency, status, created_at
       FROM wager_transactions
      WHERE provider_id = $1 AND external_transaction_id = $2`,
    [tx.providerId, tx.referenceExternalTransactionId],
  );
  const row = r.rows[0];
  if (!row) {
    tx.markPendingReference();
    return {};
  }

  const ref = WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    walletId: row.wallet_id,
    playerId: row.player_id,
    roundId: row.round_id,
    gameId: row.game_id,
    kind: row.kind as WagerTransactionKind,
    money: Money.from({ amount: row.amount, currency: String(row.currency).trim() }),
    createdAt: row.created_at,
    status: row.status as WagerTransactionStatus,
  });

  // A referencia e outra reversao ainda pendente: espera.
  if (ref.status === WagerTransactionStatus.PendingReference) {
    tx.markPendingReference();
    return {};
  }

  const code = tx.validateAgainst(ref);
  if (code) {
    tx.reject(code);
    return {};
  }

  // Sob o lock da wallet: a referencia ja foi revertida (por REFUND ou ROLLBACK)?
  const dup = await db.query(
    `SELECT 1 FROM wager_transactions
      WHERE reference_transaction_id = $1
        AND kind IN ('REFUND','ROLLBACK')
        AND status = 'PROCESSED'
      LIMIT 1`,
    [ref.id],
  );
  if (dup.rowCount && dup.rowCount > 0) {
    tx.reject(FailureCode.AlreadyReversed);
    return {};
  }

  const movement = { entryId: randomUUID(), transactionId: tx.id, money: tx.money, at: now };
  let entry: WalletLedgerEntry;
  try {
    entry =
      tx.ledgerDirectionFor(ref) === LedgerDirection.Debit
        ? wallet.debit(movement)
        : wallet.credit(movement);
  } catch (error) {
    if (error instanceof InsufficientFundsError) {
      tx.reject(FailureCode.ReversalInsufficientFunds);
      return {};
    }
    throw error;
  }
  tx.markProcessed(ref.id, now);
  return { entry };
}

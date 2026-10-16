import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { WagerTransaction } from '../domain/wager-transaction.js';
import { WagerTransactionStatus } from '../domain/wager-transaction.js';
import type { Wallet } from '../domain/wallet.js';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';

/** Grava um evento na outbox, dentro da transacao do chamador. */
export async function enqueueEvent(
  db: PoolClient,
  eventType: string,
  aggregateId: string,
  correlationId: string,
  data: Record<string, unknown>,
  occurredAt: Date,
): Promise<void> {
  const eventId = randomUUID();
  const envelope = {
    eventId,
    eventType,
    aggregateId,
    correlationId,
    occurredAt: occurredAt.toISOString(),
    version: 1,
    data,
  };
  await db.query(
    `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [eventId, aggregateId, eventType, JSON.stringify(envelope), occurredAt],
  );
}

/** Insere o lancamento e atualiza o saldo (com checagem de version). */
export async function applyWalletEffects(
  db: PoolClient,
  wallet: Wallet,
  previousVersion: number,
  entry: WalletLedgerEntry,
  now: Date,
): Promise<void> {
  await db.query(
    `INSERT INTO wallet_ledger_entries
       (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      entry.id,
      wallet.id,
      entry.transactionId,
      entry.direction,
      entry.money.toString(),
      entry.balanceBefore.toString(),
      entry.balanceAfter.toString(),
      now,
    ],
  );
  const upd = await db.query(
    `UPDATE wallets SET balance = $1, version = $2, updated_at = $3
      WHERE id = $4 AND version = $5`,
    [wallet.balance.toString(), wallet.version, now, wallet.id, previousVersion],
  );
  if (upd.rowCount !== 1) throw new Error('conflito de versao da wallet');
}

/** Eventos de integracao do resultado da transacao (mesma transacao SQL). */
export async function emitTransactionEvents(
  db: PoolClient,
  tx: WagerTransaction,
  wallet: Wallet,
  entry: WalletLedgerEntry | undefined,
  now: Date,
): Promise<void> {
  const base = {
    transactionId: tx.id,
    walletId: wallet.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
  if (tx.status === WagerTransactionStatus.Processed) {
    await enqueueEvent(db, 'WagerTransactionProcessed', tx.id, tx.id, {
      ...base,
      balanceAfter: wallet.balance.toJSON(),
    }, now);
  } else if (tx.status === WagerTransactionStatus.Rejected) {
    await enqueueEvent(db, 'WagerTransactionRejected', tx.id, tx.id, {
      ...base,
      failureCode: tx.failureCode,
    }, now);
  } else if (tx.status === WagerTransactionStatus.PendingReference) {
    await enqueueEvent(db, 'WagerTransactionPendingReference', tx.id, tx.id, {
      ...base,
      referenceExternalTransactionId: tx.referenceExternalTransactionId,
    }, now);
  }
  if (entry) {
    await enqueueEvent(db, 'WalletBalanceChanged', wallet.id, tx.id, {
      walletId: wallet.id,
      transactionId: tx.id,
      direction: entry.direction,
      money: entry.money.toJSON(),
      balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(),
      walletVersion: wallet.version,
    }, now);
  }
}

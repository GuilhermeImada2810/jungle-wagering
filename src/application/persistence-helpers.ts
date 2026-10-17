import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  type EventContext,
  type IntegrationEvent,
  type TransactionEventData,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/integration-event.js';
import { OutboxMessage } from '../domain/outbox-message.js';
import type { WagerTransaction } from '../domain/wager-transaction.js';
import { WagerTransactionStatus } from '../domain/wager-transaction.js';
import type { Wallet } from '../domain/wallet.js';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';

/** Grava um evento na outbox, dentro da transacao do chamador. */
export async function enqueueIntegrationEvent(
  db: PoolClient,
  event: IntegrationEvent<unknown>,
): Promise<void> {
  const msg = OutboxMessage.enqueue(event);
  await db.query(
    `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [msg.id, msg.aggregateId, msg.eventType, JSON.stringify(msg.payload), msg.occurredAt],
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
  const ctx = (): EventContext => ({
    eventId: randomUUID(),
    correlationId: tx.id,
    occurredAt: now,
  });
  const base: TransactionEventData = {
    transactionId: tx.id,
    walletId: wallet.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };

  if (tx.status === WagerTransactionStatus.Processed) {
    await enqueueIntegrationEvent(
      db,
      WagerTransactionProcessed.from(tx.id, { ...base, balanceAfter: wallet.balance.toJSON() }, ctx()),
    );
  } else if (tx.status === WagerTransactionStatus.Rejected) {
    await enqueueIntegrationEvent(
      db,
      WagerTransactionRejected.from(tx.id, { ...base, failureCode: tx.failureCode }, ctx()),
    );
  } else if (tx.status === WagerTransactionStatus.PendingReference) {
    await enqueueIntegrationEvent(
      db,
      WagerTransactionPendingReference.from(
        tx.id,
        { ...base, referenceExternalTransactionId: tx.referenceExternalTransactionId },
        ctx(),
      ),
    );
  }
  if (entry) {
    await enqueueIntegrationEvent(
      db,
      WalletBalanceChanged.from(
        wallet.id,
        {
          walletId: wallet.id,
          transactionId: tx.id,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          walletVersion: wallet.version,
        },
        ctx(),
      ),
    );
  }
}

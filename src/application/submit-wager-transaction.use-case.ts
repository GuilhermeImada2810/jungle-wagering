import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { FailureCode } from '../domain/failure-code.js';
import { CurrencyMismatchError, Money, type MoneyProps } from '../domain/money.js';
import { computePayloadHash } from '../domain/payload-hash.js';
import {
  InvalidTransactionError,
  WagerTransaction,
  WagerTransactionKind,
} from '../domain/wager-transaction.js';
import { InsufficientFundsError, Wallet } from '../domain/wallet.js';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';
import { PG_POOL } from '../infrastructure/database/database.module.js';
import { withTransaction } from '../infrastructure/database/transaction.js';

export class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRequestError';
  }
}
export class UnsupportedKindError extends Error {
  constructor(kind: string) {
    super(`${kind} ainda nao e suportado`);
    this.name = 'UnsupportedKindError';
  }
}
export class WalletNotFoundError extends Error {
  constructor() {
    super('wallet nao encontrada');
    this.name = 'WalletNotFoundError';
  }
}
export class IdempotencyConflictError extends Error {
  constructor() {
    super('idempotency key ou transacao externa ja usada com outro payload');
    this.name = 'IdempotencyConflictError';
  }
}
class IdempotencyRaceError extends Error {}

export interface SubmitInput {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
}

export interface SubmitResult {
  transactionId: string;
  status: string;
  failureCode?: string;
  balance: MoneyProps;
  idempotentReplay: boolean;
}

const SUPPORTED = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
];

@Injectable()
export class SubmitWagerTransactionUseCase {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async execute(input: SubmitInput): Promise<SubmitResult> {
    const kind = this.parseKind(input.kind);
    let money: Money;
    try {
      if (!/^[A-Z]{3}$/.test(input.money.currency)) throw new Error('currency');
      money = Money.from(input.money);
    } catch {
      throw new InvalidRequestError('money invalido');
    }

    const payloadHash = computePayloadHash({
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind,
      money,
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await withTransaction(this.pool, (db) =>
          this.run(db, input, kind, money, payloadHash),
        );
      } catch (error) {
        if (error instanceof IdempotencyRaceError && attempt === 0) continue;
        throw error;
      }
    }
    throw new IdempotencyRaceError('corrida de idempotencia persistente');
  }

  private parseKind(raw: string): WagerTransactionKind {
    const kind = Object.values(WagerTransactionKind).find((k) => k === raw);
    if (!kind || kind === WagerTransactionKind.Opening) {
      throw new InvalidRequestError('kind invalido');
    }
    if (!SUPPORTED.includes(kind)) throw new UnsupportedKindError(kind);
    return kind;
  }

  private async run(
    db: PoolClient,
    input: SubmitInput,
    kind: WagerTransactionKind,
    money: Money,
    payloadHash: string,
  ): Promise<SubmitResult> {
    // 1) Lock da wallet ANTES de qualquer insert (evita deadlock com o FK).
    const w = await db.query(
      `SELECT id, player_id, currency, balance, version, created_at, updated_at
         FROM wallets WHERE id = $1 FOR UPDATE`,
      [input.walletId],
    );
    if (w.rowCount === 0) throw new WalletNotFoundError();
    const row = w.rows[0];
    if (row.player_id !== input.playerId) {
      throw new InvalidRequestError('walletId nao pertence ao playerId');
    }

    // 2) Idempotencia: ja existe?
    const ex = await db.query(
      `SELECT id, status, failure_code, balance_after, payload_hash, idempotency_key, currency
         FROM wager_transactions
        WHERE provider_id = $1 AND (idempotency_key = $2 OR external_transaction_id = $3)`,
      [input.providerId, input.idempotencyKey, input.externalTransactionId],
    );
    if (ex.rowCount && ex.rowCount > 0) {
      const same = ex.rows.find(
        (r) => r.payload_hash === payloadHash && r.idempotency_key === input.idempotencyKey,
      );
      if (!same) throw new IdempotencyConflictError();
      const result: SubmitResult = {
        transactionId: same.id,
        status: same.status,
        balance: { amount: same.balance_after ?? row.balance, currency: same.currency },
        idempotentReplay: true,
      };
      if (same.failure_code) result.failureCode = same.failure_code;
      return result;
    }

    // 3) Regra de negocio no dominio
    const now = new Date();
    const txId = randomUUID();
    const wallet = Wallet.rehydrate({
      id: row.id,
      playerId: row.player_id,
      currency: row.currency,
      balance: Money.from({ amount: row.balance, currency: row.currency }),
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });

    let tx: WagerTransaction;
    try {
      tx = WagerTransaction.create({
        id: txId,
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash,
        walletId: input.walletId,
        playerId: input.playerId,
        roundId: input.roundId,
        gameId: input.gameId,
        kind,
        money,
        createdAt: now,
      });
    } catch (error) {
      if (error instanceof InvalidTransactionError) {
        throw new InvalidRequestError(error.message);
      }
      throw error;
    }

    let entry: WalletLedgerEntry | undefined;
    if (money.currency !== wallet.currency) {
      tx.reject(FailureCode.CurrencyMismatch);
    } else if (kind === WagerTransactionKind.Loss) {
      tx.markProcessed(undefined, now);
    } else {
      try {
        const movement = { entryId: randomUUID(), transactionId: txId, money, at: now };
        entry =
          kind === WagerTransactionKind.Bet ? wallet.debit(movement) : wallet.credit(movement);
        tx.markProcessed(undefined, now);
      } catch (error) {
        if (error instanceof InsufficientFundsError) tx.reject(FailureCode.InsufficientFunds);
        else if (error instanceof CurrencyMismatchError) tx.reject(FailureCode.CurrencyMismatch);
        else throw error;
      }
    }

    // 4) Persistencia: transacao, ledger, saldo e outbox, tudo no mesmo COMMIT
    const inserted = await db.query(
      `INSERT INTO wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, amount, currency,
          status, failure_code, balance_after, created_at, processed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT DO NOTHING RETURNING id`,
      [
        txId,
        input.providerId,
        input.externalTransactionId,
        input.idempotencyKey,
        payloadHash,
        input.walletId,
        input.playerId,
        input.roundId,
        input.gameId,
        kind,
        money.toString(),
        money.currency,
        tx.status,
        tx.failureCode ?? null,
        wallet.balance.toString(),
        now,
        tx.processedAt ?? null,
      ],
    );
    if (inserted.rowCount === 0) throw new IdempotencyRaceError('corrida de idempotencia');

    if (entry) {
      await db.query(
        `INSERT INTO wallet_ledger_entries
           (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          entry.id,
          wallet.id,
          txId,
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
        [wallet.balance.toString(), wallet.version, now, wallet.id, row.version],
      );
      if (upd.rowCount !== 1) throw new Error('conflito de versao da wallet');
    }

    const base = {
      transactionId: txId,
      walletId: wallet.id,
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      kind,
      money: money.toJSON(),
    };
    if (tx.status === 'PROCESSED') {
      await this.enqueue(db, 'WagerTransactionProcessed', txId, txId, {
        ...base,
        balanceAfter: wallet.balance.toJSON(),
      }, now);
    } else {
      await this.enqueue(db, 'WagerTransactionRejected', txId, txId, {
        ...base,
        failureCode: tx.failureCode,
      }, now);
    }
    if (entry) {
      await this.enqueue(db, 'WalletBalanceChanged', wallet.id, txId, {
        walletId: wallet.id,
        transactionId: txId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      }, now);
    }

    const result: SubmitResult = {
      transactionId: txId,
      status: tx.status,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
    };
    if (tx.failureCode) result.failureCode = tx.failureCode;
    return result;
  }

  private async enqueue(
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
}

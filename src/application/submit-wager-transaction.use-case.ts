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
  WagerTransactionStatus,
} from '../domain/wager-transaction.js';
import { InsufficientFundsError, Wallet } from '../domain/wallet.js';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';
import { PG_POOL } from '../infrastructure/database/database.module.js';
import { withTransaction } from '../infrastructure/database/transaction.js';
import { applyWalletEffects, emitTransactionEvents } from './persistence-helpers.js';
import { resolveReversal } from './reversal.js';
import { logJson } from '../infrastructure/json-logger.js';
import { metrics } from '../infrastructure/metrics.js';

export class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRequestError';
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
  referenceExternalTransactionId?: string;
}

export interface SubmitResult {
  transactionId: string;
  status: string;
  failureCode?: string;
  balance: MoneyProps;
  idempotentReplay: boolean;
}

const REFERENCE_FIRST_RETRY_MS = 5000;

@Injectable()
export class SubmitWagerTransactionUseCase {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async execute(input: SubmitInput, db?: PoolClient): Promise<SubmitResult> {
    const started = process.hrtime.bigint();
    try {
      return await this.executeInner(input, db);
    } finally {
      metrics.observe('wager_processing_seconds', Number(process.hrtime.bigint() - started) / 1e9);
    }
  }

  private async executeInner(input: SubmitInput, db?: PoolClient): Promise<SubmitResult> {
    const kind = this.parseKind(input.kind);
    let money: Money;
    try {
      if (!/^[A-Z]{3}$/.test(input.money.currency)) throw new Error('currency');
      money = Money.from(input.money);
    } catch {
      throw new InvalidRequestError('money invalido');
    }

    const isReversal =
      kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
    const payloadHash = computePayloadHash({
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind,
      money,
      referenceExternalTransactionId: isReversal ? input.referenceExternalTransactionId : undefined,
    });

    if (db) return this.run(db, input, kind, money, payloadHash);

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

    // 2) Idempotencia
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
      if (!same) {
        metrics.inc('wager_idempotency_conflicts_total');
        throw new IdempotencyConflictError();
      }
      metrics.inc('wager_duplicates_total');
      const replay: SubmitResult = {
        transactionId: same.id,
        status: same.status,
        balance: { amount: same.balance_after ?? row.balance, currency: same.currency },
        idempotentReplay: true,
      };
      if (same.failure_code) replay.failureCode = same.failure_code;
      return replay;
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
    const previousVersion = wallet.version;

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
        ...(input.referenceExternalTransactionId
          ? { referenceExternalTransactionId: input.referenceExternalTransactionId }
          : {}),
        createdAt: now,
      });
    } catch (error) {
      if (error instanceof InvalidTransactionError) throw new InvalidRequestError(error.message);
      throw error;
    }

    let entry: WalletLedgerEntry | undefined;
    if (money.currency !== wallet.currency) {
      tx.reject(FailureCode.CurrencyMismatch);
    } else if (kind === WagerTransactionKind.Loss) {
      tx.markProcessed(undefined, now);
    } else if (kind === WagerTransactionKind.Bet || kind === WagerTransactionKind.Win) {
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
    } else {
      entry = (await resolveReversal(db, wallet, tx, now)).entry;
    }

    // 4) Persistencia: transacao, ledger, saldo e outbox, tudo no mesmo COMMIT
    const pending = tx.status === WagerTransactionStatus.PendingReference;
    const inserted = await db.query(
      `INSERT INTO wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, amount, currency,
          status, failure_code, balance_after, created_at, processed_at,
          reference_external_transaction_id, reference_transaction_id, reference_next_attempt_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
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
        tx.referenceExternalTransactionId ?? null,
        tx.referenceTransactionId ?? null,
        pending ? new Date(now.getTime() + REFERENCE_FIRST_RETRY_MS) : null,
      ],
    );
    if (inserted.rowCount === 0) throw new IdempotencyRaceError('corrida de idempotencia');

    if (entry) await applyWalletEffects(db, wallet, previousVersion, entry, now);
    await emitTransactionEvents(db, tx, wallet, entry, now);

    metrics.inc('wager_transactions_total', { status: tx.status, kind });
    logJson('info', 'wager_transaction_result', {
      correlationId: txId,
      transactionId: txId,
      walletId: input.walletId,
      providerId: input.providerId,
      status: tx.status,
      failureCode: tx.failureCode,
    });
    const result: SubmitResult = {
      transactionId: txId,
      status: tx.status,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
    };
    if (tx.failureCode) result.failureCode = tx.failureCode;
    return result;
  }
}




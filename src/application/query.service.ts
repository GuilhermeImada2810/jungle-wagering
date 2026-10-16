import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../infrastructure/database/database.module.js';

export class InvalidCursorError extends Error {
  constructor() {
    super('cursor invalido');
    this.name = 'InvalidCursorError';
  }
}

const money = (amount: string, currency: string) => ({ amount, currency: currency.trim() });

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!createdAt || !id || Number.isNaN(Date.parse(createdAt))) throw new Error();
    return { createdAt, id };
  } catch {
    throw new InvalidCursorError();
  }
}

@Injectable()
export class QueryService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async getWallet(id: string) {
    const r = await this.pool.query(
      `SELECT id, player_id, currency, balance::text AS balance, version
         FROM wallets WHERE id = $1`,
      [id],
    );
    const w = r.rows[0];
    if (!w) return undefined;
    return {
      id: w.id as string,
      playerId: w.player_id as string,
      balance: money(w.balance, w.currency),
      version: w.version as number,
    };
  }

  async getLedger(walletId: string, cursor: string | undefined, limit: number) {
    const params: unknown[] = [walletId];
    let where = 'wallet_id = $1';
    if (cursor) {
      const c = decodeCursor(cursor);
      params.push(c.createdAt, c.id);
      where += ' AND (created_at, id) > ($2::timestamptz, $3::uuid)';
    }
    params.push(limit + 1);
    const r = await this.pool.query(
      `SELECT id, transaction_id, direction, amount::text AS amount,
              balance_before::text AS balance_before, balance_after::text AS balance_after,
              created_at
         FROM wallet_ledger_entries
        WHERE ${where}
        ORDER BY created_at, id
        LIMIT $${params.length}`,
      params,
    );
    const rows = r.rows.slice(0, limit);
    const w = await this.pool.query('SELECT currency FROM wallets WHERE id = $1', [walletId]);
    const currency = (w.rows[0]?.currency as string | undefined) ?? 'BRL';
    const last = rows[rows.length - 1];
    return {
      items: rows.map((e) => ({
        id: e.id as string,
        transactionId: e.transaction_id as string,
        direction: e.direction as string,
        money: money(e.amount, currency),
        balanceBefore: money(e.balance_before, currency),
        balanceAfter: money(e.balance_after, currency),
        createdAt: (e.created_at as Date).toISOString(),
      })),
      nextCursor:
        r.rows.length > limit && last ? encodeCursor(last.created_at as Date, last.id as string) : null,
    };
  }

  async getTransactionById(id: string) {
    const r = await this.pool.query(this.txSql('t.id = $1'), [id]);
    return this.mapTx(r.rows[0]);
  }

  async getTransactionByExternal(providerId: string, externalId: string) {
    const r = await this.pool.query(
      this.txSql('t.provider_id = $1 AND t.external_transaction_id = $2'),
      [providerId, externalId],
    );
    return this.mapTx(r.rows[0]);
  }

  private txSql(where: string): string {
    return `SELECT t.id, t.provider_id, t.external_transaction_id, t.wallet_id, t.round_id,
                   t.game_id, t.kind, t.status, t.failure_code, t.currency,
                   t.amount::text AS amount, t.balance_after::text AS balance_after,
                   t.created_at, t.processed_at
              FROM wager_transactions t WHERE ${where}`;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapTx(t: any) {
    if (!t) return undefined;
    return {
      transactionId: t.id as string,
      providerId: t.provider_id as string,
      externalTransactionId: t.external_transaction_id as string,
      walletId: t.wallet_id as string,
      roundId: t.round_id as string,
      gameId: t.game_id as string,
      kind: t.kind as string,
      status: t.status as string,
      failureCode: (t.failure_code as string | null) ?? undefined,
      money: money(t.amount, t.currency),
      balance: t.balance_after ? money(t.balance_after, t.currency) : undefined,
      createdAt: (t.created_at as Date).toISOString(),
      processedAt: t.processed_at ? (t.processed_at as Date).toISOString() : undefined,
    };
  }
}

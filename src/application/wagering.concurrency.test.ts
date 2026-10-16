import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { CreateWalletUseCase } from './create-wallet.use-case.js';
import {
  IdempotencyConflictError,
  SubmitWagerTransactionUseCase,
  type SubmitInput,
} from './submit-wager-transaction.use-case.js';

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  user: 'wagering',
  password: 'wagering',
  database: 'wagering',
  max: 20,
});
const createWallet = new CreateWalletUseCase(pool);
const submit = new SubmitWagerTransactionUseCase(pool);

afterAll(async () => {
  await pool.end();
});

async function newWallet(balance: string) {
  const playerId = randomUUID();
  const w = await createWallet.execute({
    playerId,
    initialBalance: { amount: balance, currency: 'BRL' },
  });
  return { walletId: w.id, playerId };
}

function req(
  w: { walletId: string; playerId: string },
  ext: string,
  kind: string,
  amount: string,
): SubmitInput {
  return {
    idempotencyKey: `provider-a:${ext}`,
    providerId: 'provider-a',
    externalTransactionId: ext,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: { amount, currency: 'BRL' },
  };
}

async function state(walletId: string) {
  const r = await pool.query(
    `SELECT w.balance::text AS balance,
            COALESCE((SELECT SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END)
                        FROM wallet_ledger_entries WHERE wallet_id = w.id), 0)::text AS ledger,
            (SELECT COUNT(*) FROM wallet_ledger_entries
              WHERE wallet_id = w.id AND direction = 'DEBIT')::int AS debits
       FROM wallets w WHERE w.id = $1`,
    [walletId],
  );
  return r.rows[0] as { balance: string; ledger: string; debits: number };
}

describe('concorrencia (Postgres real)', () => {
  test('duas apostas de 80 com saldo 100: uma processa, outra rejeita', async () => {
    const w = await newWallet('100.00');
    const results = await Promise.all([
      submit.execute(req(w, `a-${randomUUID()}`, 'BET', '80.00')),
      submit.execute(req(w, `b-${randomUUID()}`, 'BET', '80.00')),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    const s = await state(w.walletId);
    expect(s.balance).toBe('20.00');
    expect(s.debits).toBe(1);
    expect(s.ledger).toBe(s.balance);
  });

  test('a mesma aposta enviada 50 vezes em paralelo gera um unico debito', async () => {
    const w = await newWallet('100.00');
    const same = req(w, `dup-${randomUUID()}`, 'BET', '25.00');
    const results = await Promise.all(Array.from({ length: 50 }, () => submit.execute(same)));
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    const s = await state(w.walletId);
    expect(s.balance).toBe('75.00');
    expect(s.debits).toBe(1);
    expect(s.ledger).toBe(s.balance);
  });

  test('mesma key com payload diferente e conflito', async () => {
    const w = await newWallet('100.00');
    const first = req(w, `cf-${randomUUID()}`, 'BET', '10.00');
    await submit.execute(first);
    const changed = { ...first, money: { amount: '11.00', currency: 'BRL' } };
    await expect(submit.execute(changed)).rejects.toThrow(IdempotencyConflictError);
    const s = await state(w.walletId);
    expect(s.balance).toBe('90.00');
  });

  test('wallets distintas em paralelo, cada uma consistente com o ledger', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => newWallet('100.00')));
    await Promise.all(
      wallets.map((w) => submit.execute(req(w, `p-${randomUUID()}`, 'BET', '30.00'))),
    );
    for (const w of wallets) {
      const s = await state(w.walletId);
      expect(s.balance).toBe('70.00');
      expect(s.ledger).toBe(s.balance);
    }
  });

  test('WIN credita e LOSS nao move saldo', async () => {
    const w = await newWallet('100.00');
    await submit.execute(req(w, `w-${randomUUID()}`, 'WIN', '50.00'));
    await submit.execute(req(w, `l-${randomUUID()}`, 'LOSS', '0.00'));
    const s = await state(w.walletId);
    expect(s.balance).toBe('150.00');
    expect(s.ledger).toBe(s.balance);
  });
});

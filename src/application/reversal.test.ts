import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { CreateWalletUseCase } from './create-wallet.use-case.js';
import { ReferenceReprocessor } from './reference-reprocessor.js';
import { SubmitWagerTransactionUseCase, type SubmitInput } from './submit-wager-transaction.use-case.js';

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
const reprocessor = new ReferenceReprocessor(pool);

afterAll(async () => {
  await pool.end();
});

type W = { walletId: string; playerId: string };

async function newWallet(balance: string): Promise<W> {
  const playerId = randomUUID();
  const w = await createWallet.execute({
    playerId,
    initialBalance: { amount: balance, currency: 'BRL' },
  });
  return { walletId: w.id, playerId };
}

function rq(w: W, ext: string, kind: string, amount: string, ref?: string): SubmitInput {
  const base: SubmitInput = {
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
  if (ref) base.referenceExternalTransactionId = ref;
  return base;
}

async function state(walletId: string) {
  const r = await pool.query(
    `SELECT w.balance::text AS balance,
            COALESCE((SELECT SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END)
                        FROM wallet_ledger_entries WHERE wallet_id = w.id), 0)::text AS ledger
       FROM wallets w WHERE w.id = $1`,
    [walletId],
  );
  return r.rows[0] as { balance: string; ledger: string };
}

const uid = (p: string) => `${p}-${randomUUID()}`;

describe('REFUND e ROLLBACK (Postgres real)', () => {
  test('REFUND reverte a BET uma unica vez; o segundo e ALREADY_REVERSED', async () => {
    const w = await newWallet('100.00');
    const bet = uid('bet');
    await submit.execute(rq(w, bet, 'BET', '30.00'));
    const r1 = await submit.execute(rq(w, uid('rf'), 'REFUND', '30.00', bet));
    const r2 = await submit.execute(rq(w, uid('rf'), 'REFUND', '30.00', bet));
    expect(r1.status).toBe('PROCESSED');
    expect(r2.status).toBe('REJECTED');
    expect(r2.failureCode).toBe('ALREADY_REVERSED');
    const s = await state(w.walletId);
    expect(s.balance).toBe('100.00');
    expect(s.ledger).toBe(s.balance);
  });

  test('20 REFUNDs concorrentes da mesma BET: exatamente um credito', async () => {
    const w = await newWallet('100.00');
    const bet = uid('bet');
    await submit.execute(rq(w, bet, 'BET', '40.00'));
    const results = await Promise.all(
      Array.from({ length: 20 }, () => submit.execute(rq(w, uid('rf'), 'REFUND', '40.00', bet))),
    );
    expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(1);
    expect(results.filter((r) => r.failureCode === 'ALREADY_REVERSED')).toHaveLength(19);
    const s = await state(w.walletId);
    expect(s.balance).toBe('100.00');
    expect(s.ledger).toBe(s.balance);
  });

  test('REFUND e ROLLBACK da mesma BET nao revertem duas vezes', async () => {
    const w = await newWallet('100.00');
    const bet = uid('bet');
    await submit.execute(rq(w, bet, 'BET', '30.00'));
    const a = await submit.execute(rq(w, uid('rf'), 'REFUND', '30.00', bet));
    const b = await submit.execute(rq(w, uid('rb'), 'ROLLBACK', '30.00', bet));
    expect(a.status).toBe('PROCESSED');
    expect(b.failureCode).toBe('ALREADY_REVERSED');
    expect((await state(w.walletId)).balance).toBe('100.00');
  });

  test('ROLLBACK de BET credita; ROLLBACK de WIN debita', async () => {
    const w = await newWallet('100.00');
    const bet = uid('bet');
    const win = uid('win');
    await submit.execute(rq(w, bet, 'BET', '30.00')); // 70
    await submit.execute(rq(w, win, 'WIN', '50.00')); // 120
    const rbBet = await submit.execute(rq(w, uid('rb'), 'ROLLBACK', '30.00', bet)); // 150
    const rbWin = await submit.execute(rq(w, uid('rb'), 'ROLLBACK', '50.00', win)); // 100
    expect(rbBet.status).toBe('PROCESSED');
    expect(rbWin.status).toBe('PROCESSED');
    const s = await state(w.walletId);
    expect(s.balance).toBe('100.00');
    expect(s.ledger).toBe(s.balance);
  });

  test('reversao que deixaria saldo negativo: REVERSAL_INSUFFICIENT_FUNDS', async () => {
    const w = await newWallet('100.00');
    const win = uid('win');
    await submit.execute(rq(w, win, 'WIN', '50.00')); // 150
    await submit.execute(rq(w, uid('bet'), 'BET', '150.00')); // 0
    const rb = await submit.execute(rq(w, uid('rb'), 'ROLLBACK', '50.00', win));
    expect(rb.status).toBe('REJECTED');
    expect(rb.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    const s = await state(w.walletId);
    expect(s.balance).toBe('0.00');
    expect(s.ledger).toBe(s.balance);
  });

  test('valor diferente da referencia: AMOUNT_MISMATCH', async () => {
    const w = await newWallet('100.00');
    const bet = uid('bet');
    await submit.execute(rq(w, bet, 'BET', '30.00'));
    const rf = await submit.execute(rq(w, uid('rf'), 'REFUND', '10.00', bet));
    expect(rf.failureCode).toBe('AMOUNT_MISMATCH');
  });

  test('REFUND antes da BET: fica PENDING_REFERENCE e o worker aplica depois', async () => {
    const w = await newWallet('100.00');
    const bet = uid('bet');
    const early = await submit.execute(rq(w, uid('rf'), 'REFUND', '25.00', bet));
    expect(early.status).toBe('PENDING_REFERENCE');
    expect((await state(w.walletId)).balance).toBe('100.00');

    await submit.execute(rq(w, bet, 'BET', '25.00')); // 75
    await pool.query(
      `UPDATE wager_transactions SET reference_next_attempt_at = now() - interval '1 second' WHERE id = $1`,
      [early.transactionId],
    );
    await reprocessor.processDue(1000);

    const t = await pool.query('SELECT status FROM wager_transactions WHERE id = $1', [
      early.transactionId,
    ]);
    expect(t.rows[0].status).toBe('PROCESSED');
    const s = await state(w.walletId);
    expect(s.balance).toBe('100.00');
    expect(s.ledger).toBe(s.balance);
  });

  test('referencia que nunca chega: REJECTED REFERENCE_NOT_FOUND apos o limite', async () => {
    const w = await newWallet('100.00');
    const early = await submit.execute(rq(w, uid('rb'), 'ROLLBACK', '25.00', uid('ghost')));
    expect(early.status).toBe('PENDING_REFERENCE');
    for (let i = 0; i < 2; i++) {
      await pool.query(
        `UPDATE wager_transactions SET reference_next_attempt_at = now() - interval '1 second' WHERE id = $1`,
        [early.transactionId],
      );
      await reprocessor.processDue(1000, 2);
    }
    const t = await pool.query(
      'SELECT status, failure_code FROM wager_transactions WHERE id = $1',
      [early.transactionId],
    );
    expect(t.rows[0].status).toBe('REJECTED');
    expect(t.rows[0].failure_code).toBe('REFERENCE_NOT_FOUND');
    const ev = await pool.query(
      `SELECT COUNT(*)::int AS n FROM outbox_messages
        WHERE event_type = 'WagerTransactionRejected' AND payload->>'correlationId' = $1`,
      [early.transactionId],
    );
    expect(ev.rows[0].n).toBe(1);
    expect((await state(w.walletId)).balance).toBe('100.00');
  });
});

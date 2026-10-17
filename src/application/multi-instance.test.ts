import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const PORTS = [3101, 3102, 3103];
const MAIN = ['dist/src/main.js', 'dist/main.js'].find((p) => existsSync(p));
const procs: Array<{ kill: () => void }> = [];

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  user: 'wagering',
  password: 'wagering',
  database: 'wagering',
  max: 5,
});

async function waitUp(port: number): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://localhost:${port}/health/live`);
      if (r.ok) return;
    } catch {
      // ainda subindo
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`instancia ${port} nao subiu`);
}

beforeAll(async () => {
  if (!MAIN) throw new Error('rode "bun run build" antes (dist/main.js nao encontrado)');
  for (const port of PORTS) {
    procs.push(
      Bun.spawn(['node', MAIN], {
        env: {
          ...process.env,
          PORT: String(port),
          OUTBOX_DISABLED: 'true',
          SQS_CONSUMER_DISABLED: 'true',
          EVENT_PUBLISHER: 'log',
        },
        stdout: 'ignore',
        stderr: 'ignore',
      }),
    );
  }
  await Promise.all(PORTS.map(waitUp));
}, 60000);

afterAll(async () => {
  for (const p of procs) p.kill();
  await pool.end();
});

const url = (i: number, path: string) => `http://localhost:${PORTS[i % PORTS.length]}${path}`;

async function newWallet(balance: string) {
  const playerId = randomUUID();
  const res = await fetch(url(0, '/wallets'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: balance, currency: 'BRL' } }),
  });
  expect(res.status).toBe(201);
  const w = (await res.json()) as { id: string };
  return { walletId: w.id, playerId };
}

function bet(w: { walletId: string; playerId: string }, ext: string, amount: string, i: number) {
  return fetch(url(i, '/wagering/transactions'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `provider-a:${ext}` },
    body: JSON.stringify({
      providerId: 'provider-a',
      externalTransactionId: ext,
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    }),
  });
}

async function state(walletId: string) {
  const r = await pool.query(
    `SELECT w.balance::text AS balance,
            COALESCE((SELECT SUM(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END)
                        FROM wallet_ledger_entries WHERE wallet_id = w.id), 0)::text AS ledger,
            (SELECT COUNT(*)::int FROM wallet_ledger_entries
              WHERE wallet_id = w.id AND direction='DEBIT') AS debits
       FROM wallets w WHERE w.id = $1`,
    [walletId],
  );
  return r.rows[0] as { balance: string; ledger: string; debits: number };
}

describe('3 instancias reais (processos Node) no mesmo Postgres', () => {
  test('30 apostas distintas de 10 com saldo 100: exatamente 10 passam', async () => {
    const w = await newWallet('100.00');
    const responses = await Promise.all(
      Array.from({ length: 30 }, (_, i) => bet(w, `m-${randomUUID()}`, '10.00', i)),
    );
    const codes = responses.map((r) => r.status);
    expect(codes.filter((c) => c === 200)).toHaveLength(10);
    expect(codes.filter((c) => c === 422)).toHaveLength(20);
    const s = await state(w.walletId);
    expect(s.balance).toBe('0.00');
    expect(s.debits).toBe(10);
    expect(s.ledger).toBe(s.balance);
  });

  test('a mesma aposta enviada 60 vezes espalhada nas 3 instancias gera um debito', async () => {
    const w = await newWallet('100.00');
    const ext = `same-${randomUUID()}`;
    const responses = await Promise.all(Array.from({ length: 60 }, (_, i) => bet(w, ext, '25.00', i)));
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as Array<{
      idempotentReplay: boolean;
      transactionId: string;
    }>;
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(bodies.filter((b) => !b.idempotentReplay)).toHaveLength(1);
    expect(new Set(bodies.map((b) => b.transactionId)).size).toBe(1);
    const s = await state(w.walletId);
    expect(s.balance).toBe('75.00');
    expect(s.debits).toBe(1);
    expect(s.ledger).toBe(s.balance);
  });
});

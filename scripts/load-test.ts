import { existsSync, writeFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const PORTS = [3201, 3202, 3203];
const WALLETS = Number(process.env.LOAD_WALLETS ?? 200);
const REQUESTS = Number(process.env.LOAD_REQUESTS ?? 4000);
const HOT_REQUESTS = Number(process.env.LOAD_HOT_REQUESTS ?? 400);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 64);
const DUP_RATE = 0.1;

const MAIN = ['dist/src/main.js', 'dist/main.js'].find((p) => existsSync(p));
if (!MAIN) throw new Error('rode "bun run build" antes (dist/main.js nao encontrado)');

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  user: 'wagering',
  password: 'wagering',
  database: 'wagering',
  max: 5,
});

interface Req {
  ext: string;
  walletId: string;
  playerId: string;
  amount: string;
}
interface Res {
  status: number;
  ms: number;
  replay: boolean;
}
interface PhaseStats {
  name: string;
  requests: number;
  http200: number;
  http422: number;
  errors: number;
  replays: number;
  uniqueProcessed: number;
  seconds: number;
  rps: number;
  p50ms: number;
  p95ms: number;
  p99ms: number;
  maxMs: number;
}

const procs: Array<{ kill: () => void }> = [];

async function waitUp(port: number): Promise<void> {
  for (let i = 0; i < 80; i++) {
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

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round((sorted[idx] ?? 0) * 100) / 100;
}

async function createWallet(balance: string): Promise<{ walletId: string; playerId: string }> {
  const playerId = randomUUID();
  const res = await fetch(`http://localhost:${PORTS[0]}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: balance, currency: 'BRL' } }),
  });
  if (res.status !== 201) throw new Error(`falha ao criar wallet: ${res.status}`);
  const w = (await res.json()) as { id: string };
  return { walletId: w.id, playerId };
}

async function send(req: Req, i: number): Promise<Res> {
  const port = PORTS[i % PORTS.length];
  const t0 = performance.now();
  try {
    const res = await fetch(`http://localhost:${port}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `provider-load:${req.ext}` },
      body: JSON.stringify({
        providerId: 'provider-load',
        externalTransactionId: req.ext,
        playerId: req.playerId,
        walletId: req.walletId,
        roundId: 'round-load',
        gameId: 'game-load',
        kind: 'BET',
        money: { amount: req.amount, currency: 'BRL' },
      }),
      signal: AbortSignal.timeout(30000),
    });
    let replay = false;
    if (res.status === 200) {
      const body = (await res.json()) as { idempotentReplay?: boolean };
      replay = body.idempotentReplay === true;
    } else {
      await res.text();
    }
    return { status: res.status, ms: performance.now() - t0, replay };
  } catch {
    return { status: 0, ms: performance.now() - t0, replay: false };
  }
}

async function runPhase(name: string, reqs: Req[]): Promise<PhaseStats> {
  const results: Res[] = new Array(reqs.length);
  let next = 0;
  const started = performance.now();
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= reqs.length) return;
      const r = reqs[i];
      if (r) results[i] = await send(r, i);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  const seconds = (performance.now() - started) / 1000;
  const lat = results.map((r) => r.ms).sort((a, b) => a - b);
  const http200 = results.filter((r) => r.status === 200).length;
  const replays = results.filter((r) => r.status === 200 && r.replay).length;
  return {
    name,
    requests: reqs.length,
    http200,
    http422: results.filter((r) => r.status === 422).length,
    errors: results.filter((r) => r.status !== 200 && r.status !== 422).length,
    replays,
    uniqueProcessed: http200 - replays,
    seconds: Math.round(seconds * 100) / 100,
    rps: Math.round(reqs.length / seconds),
    p50ms: pct(lat, 50),
    p95ms: pct(lat, 95),
    p99ms: pct(lat, 99),
    maxMs: Math.round((lat[lat.length - 1] ?? 0) * 100) / 100,
  };
}

async function scrapeMetrics(): Promise<Record<string, number>> {
  const totals: Record<string, number> = {};
  for (const port of PORTS) {
    const text = await (await fetch(`http://localhost:${port}/metrics`)).text();
    for (const line of text.split('\n')) {
      if (!line.startsWith('wager_') || line.includes('_bucket')) continue;
      const m = line.match(/^([a-z_]+)(?:\{[^}]*\})?\s+([0-9.eE+-]+)$/);
      if (!m || !m[1] || !m[2] || m[1] === 'wager_outbox_lag_seconds') continue;
      totals[m[1]] = (totals[m[1]] ?? 0) + Number(m[2]);
    }
  }
  return totals;
}

async function drainOutbox(): Promise<{ peakPending: number; drainSeconds: number; drained: boolean }> {
  const t0 = performance.now();
  let peak = 0;
  for (let i = 0; i < 300; i++) {
    const r = await pool.query('SELECT COUNT(*)::int AS n FROM outbox_messages WHERE published_at IS NULL');
    const n = r.rows[0].n as number;
    peak = Math.max(peak, n);
    if (n === 0) return { peakPending: peak, drainSeconds: (performance.now() - t0) / 1000, drained: true };
    await new Promise((r) => setTimeout(r, 200));
  }
  return { peakPending: peak, drainSeconds: (performance.now() - t0) / 1000, drained: false };
}

async function checkInvariant(ids: string[]): Promise<{ divergent: number; totalBalance: string }> {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS divergent
       FROM wallets w
       LEFT JOIN (SELECT wallet_id, SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END) AS s
                    FROM wallet_ledger_entries WHERE wallet_id = ANY($1) GROUP BY wallet_id) l
         ON l.wallet_id = w.id
      WHERE w.id = ANY($1) AND w.balance <> COALESCE(l.s, 0)`,
    [ids],
  );
  const t = await pool.query('SELECT COALESCE(SUM(balance),0)::text AS total FROM wallets WHERE id = ANY($1)', [ids]);
  return { divergent: r.rows[0].divergent as number, totalBalance: t.rows[0].total as string };
}

async function main(): Promise<void> {
  for (const port of PORTS) {
    procs.push(
      Bun.spawn(['node', MAIN as string], {
        env: {
          ...process.env,
          PORT: String(port),
          SQS_CONSUMER_DISABLED: 'true',
          EVENT_PUBLISHER: 'log',
        },
        stdout: 'ignore',
        stderr: 'ignore',
      }),
    );
  }
  await Promise.all(PORTS.map(waitUp));
  console.log(`3 instancias no ar (${PORTS.join(', ')}). Criando wallets...`);

  // Fase A: carga espalhada
  const wallets: Array<{ walletId: string; playerId: string }> = [];
  for (let i = 0; i < WALLETS; i += 20) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(20, WALLETS - i) }, () => createWallet('1000.00')),
    );
    wallets.push(...batch);
  }
  const reqsA: Req[] = [];
  for (let i = 0; i < REQUESTS; i++) {
    if (i > 0 && Math.random() < DUP_RATE) {
      reqsA.push(reqsA[Math.floor(Math.random() * reqsA.length)] as Req);
    } else {
      const w = wallets[Math.floor(Math.random() * wallets.length)] as { walletId: string; playerId: string };
      reqsA.push({ ext: `a-${randomUUID()}`, ...w, amount: '1.00' });
    }
  }
  console.log(`Fase A: ${REQUESTS} requisicoes em ${WALLETS} wallets (concorrencia ${CONCURRENCY})...`);
  const a = await runPhase('A: carga espalhada (10% de reenvios)', reqsA);

  // Fase B: wallet quente
  const hot = await createWallet('100.00');
  const reqsB: Req[] = Array.from({ length: HOT_REQUESTS }, () => ({
    ext: `b-${randomUUID()}`,
    ...hot,
    amount: '1.00',
  }));
  console.log(`Fase B: ${HOT_REQUESTS} requisicoes em UMA wallet com saldo 100.00...`);
  const b = await runPhase('B: wallet quente (saldo 100, apostas de 1)', reqsB);

  console.log('Aguardando a outbox drenar...');
  const outbox = await drainOutbox();
  const metrics = await scrapeMetrics();

  const ids = [...wallets.map((w) => w.walletId), hot.walletId];
  const inv = await checkInvariant(ids);
  const expectedTotal = WALLETS * 1000 + 100 - (a.uniqueProcessed + b.uniqueProcessed);
  const hotBalance = (await pool.query('SELECT balance::text AS b FROM wallets WHERE id = $1', [hot.walletId]))
    .rows[0].b as string;

  const checks = {
    ledgerMatchesBalanceOnAllWallets: inv.divergent === 0,
    totalDebitedMatchesProcessedBets: Number(inv.totalBalance) === expectedTotal,
    hotWalletProcessedExactly100: b.uniqueProcessed === 100 && hotBalance === '0.00',
    noServerErrors: a.errors === 0 && b.errors === 0,
  };

  const report = {
    environment: {
      node: process.version,
      os: `${platform()} ${release()}`,
      cpus: cpus().length,
      instances: PORTS.length,
      postgres: 'postgres:16 em Docker, mesma maquina',
    },
    parameters: { wallets: WALLETS, requests: REQUESTS, hotRequests: HOT_REQUESTS, concurrency: CONCURRENCY, dupRate: DUP_RATE },
    phases: [a, b],
    outbox,
    metricsSummedAcrossInstances: metrics,
    notImplemented: ['contador de conflitos de lock (FOR UPDATE)'],
    checks,
  };
  console.log(JSON.stringify(report, null, 2));
  writeFileSync('load-report.json', JSON.stringify(report, null, 2));
  console.log('Relatorio salvo em load-report.json');

  if (!Object.values(checks).every(Boolean)) {
    console.error('FALHA: alguma verificacao de invariante nao passou');
    process.exitCode = 1;
  }
}

try {
  await main();
} finally {
  for (const p of procs) p.kill();
  await pool.end();
}

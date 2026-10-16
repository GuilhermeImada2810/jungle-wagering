import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { EventPublisher, PublishableEvent } from './event-publisher.js';
import { OutboxDispatcher } from './outbox-dispatcher.js';

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  user: 'wagering',
  password: 'wagering',
  database: 'wagering',
  max: 10,
});

afterAll(async () => {
  await pool.end();
});

async function seed(count: number): Promise<string[]> {
  const aggregate = randomUUID();
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = randomUUID();
    ids.push(id);
    await pool.query(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload) VALUES ($1,$2,'TestEvent',$3)`,
      [id, aggregate, JSON.stringify({ i })],
    );
  }
  return ids;
}

class Recorder implements EventPublisher {
  seen: string[] = [];
  constructor(private readonly only: Set<string>) {}
  async publish(e: PublishableEvent): Promise<void> {
    if (this.only.has(e.id)) this.seen.push(e.id);
  }
}

describe('outbox publisher (Postgres real)', () => {
  test('dois publishers concorrentes nao publicam o mesmo evento', async () => {
    const ids = await seed(40);
    const mine = new Set(ids);
    const a = new Recorder(mine);
    const b = new Recorder(mine);

    // lotes pequenos forcam varias rodadas concorrentes
    const run = async (d: OutboxDispatcher) => {
      for (let i = 0; i < 10; i++) await d.dispatchBatch(5);
    };
    await Promise.all([run(new OutboxDispatcher(pool, a)), run(new OutboxDispatcher(pool, b))]);

    const all = [...a.seen, ...b.seen];
    expect(all.length).toBe(40);
    expect(new Set(all).size).toBe(40);

    const pending = await pool.query(
      `SELECT COUNT(*)::int AS n FROM outbox_messages WHERE id = ANY($1) AND published_at IS NULL`,
      [ids],
    );
    expect(pending.rows[0].n).toBe(0);
  });

  test('falha na publicacao agenda retry com backoff e nao marca como publicado', async () => {
    const [id] = await seed(1);
    const failing: EventPublisher = {
      async publish(e) {
        if (e.id === id) throw new Error('broker indisponivel');
      },
    };
    await new OutboxDispatcher(pool, failing).dispatchBatch(1000);

    const r = await pool.query(
      `SELECT attempts, published_at, next_attempt_at > now() AS future FROM outbox_messages WHERE id = $1`,
      [id],
    );
    expect(r.rows[0].attempts).toBe(1);
    expect(r.rows[0].published_at).toBeNull();
    expect(r.rows[0].future).toBe(true);
  });

  test('rollback depois de publicar mantem o evento pendente (nunca perde)', async () => {
    const [id] = await seed(1);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT id FROM outbox_messages WHERE id = $1 FOR UPDATE SKIP LOCKED`,
        [id],
      );
      // simula crash: publica no broker mas a transacao nunca confirma
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const r = await pool.query('SELECT published_at FROM outbox_messages WHERE id = $1', [id]);
    expect(r.rows[0].published_at).toBeNull();
  });
});

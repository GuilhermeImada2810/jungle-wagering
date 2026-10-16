import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../infrastructure/database/database.module.js';
import { withTransaction } from '../infrastructure/database/transaction.js';
import { EVENT_PUBLISHER, type EventPublisher } from './event-publisher.js';

export interface DispatchResult {
  published: number;
  failed: number;
}

@Injectable()
export class OutboxDispatcher {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
  ) {}

  /**
   * Pega um lote com SKIP LOCKED (varios dispatchers nao se atropelam),
   * publica e marca como publicado no mesmo COMMIT.
   * Crash antes do COMMIT: o lock cai e outra instancia reprocessa (at-least-once).
   */
  async dispatchBatch(limit = 50): Promise<DispatchResult> {
    return withTransaction(this.pool, async (db) => {
      const r = await db.query(
        `SELECT id, event_type, aggregate_id, payload, attempts
           FROM outbox_messages
          WHERE published_at IS NULL
            AND (next_attempt_at IS NULL OR next_attempt_at <= now())
          ORDER BY occurred_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [limit],
      );

      let published = 0;
      let failed = 0;
      for (const row of r.rows) {
        try {
          await this.publisher.publish({
            id: row.id as string,
            eventType: row.event_type as string,
            aggregateId: row.aggregate_id as string,
            payload: row.payload as Record<string, unknown>,
          });
          await db.query('UPDATE outbox_messages SET published_at = now() WHERE id = $1', [row.id]);
          published += 1;
        } catch {
          const attempts = (row.attempts as number) + 1;
          const delaySeconds = Math.min(2 ** attempts, 300);
          await db.query(
            `UPDATE outbox_messages
                SET attempts = $2, next_attempt_at = now() + ($3 || ' seconds')::interval
              WHERE id = $1`,
            [row.id, attempts, String(delaySeconds)],
          );
          failed += 1;
        }
      }
      return { published, failed };
    });
  }

  async lagSeconds(): Promise<number> {
    const r = await this.pool.query(
      `SELECT COALESCE(EXTRACT(EPOCH FROM (now() - MIN(occurred_at))), 0)::float AS lag
         FROM outbox_messages WHERE published_at IS NULL`,
    );
    return r.rows[0].lag as number;
  }
}

import { ChangeMessageVisibilityCommand, SendMessageCommand, type Message } from '@aws-sdk/client-sqs';
import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { CreateWalletUseCase } from './create-wallet.use-case.js';
import { SubmitWagerTransactionUseCase } from './submit-wager-transaction.use-case.js';
import { SqsService } from '../infrastructure/sqs/sqs.service.js';
import { WagerQueueConsumer } from '../infrastructure/sqs/wager-queue-consumer.js';

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  user: 'wagering',
  password: 'wagering',
  database: 'wagering',
  max: 10,
});
const sqs = new SqsService();
const useCase = new SubmitWagerTransactionUseCase(pool);
const createWallet = new CreateWalletUseCase(pool);

/** Simula a morte do processo: o commit acontece, o ack nunca. */
class CrashingConsumer extends WagerQueueConsumer {
  crashes = 0;
  protected override async ack(m: Message, queueUrl: string): Promise<void> {
    this.crashes += 1;
    // a mensagem volta a ficar visivel em 1s, como se a visibilidade tivesse expirado
    await sqs.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: m.ReceiptHandle,
        VisibilityTimeout: 1,
      }),
    );
    throw new Error('processo morreu antes do ack');
  }
}

afterAll(async () => {
  await pool.end();
});

describe('crash entre commit e ack (Postgres e LocalStack reais)', () => {
  test('redelivery apos o crash nao duplica o debito', async () => {
    const playerId = randomUUID();
    const w = await createWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const messageId = `msg-${randomUUID()}`;
    const urls = await sqs.ensureQueues();
    await sqs.client.send(
      new SendMessageCommand({
        QueueUrl: urls.inbound,
        MessageGroupId: w.id,
        MessageDeduplicationId: randomUUID(),
        MessageBody: JSON.stringify({
          messageId,
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: {
            providerId: 'provider-a',
            externalTransactionId: `ext-${randomUUID()}`,
            idempotencyKey: `provider-a:ext-${randomUUID()}`,
            playerId,
            walletId: w.id,
            roundId: 'round-1',
            gameId: 'game-1',
            kind: 'BET',
            money: { amount: '30.00', currency: 'BRL' },
          },
        }),
      }),
    );

    // 1) processo que morre depois do commit e antes do ack
    const crashing = new CrashingConsumer(pool, sqs, useCase);
    for (let i = 0; i < 5 && crashing.crashes === 0; i++) await crashing.pollOnce(1);
    expect(crashing.crashes).toBeGreaterThan(0);

    const afterCrash = await pool.query('SELECT balance::text AS b FROM wallets WHERE id = $1', [w.id]);
    expect(afterCrash.rows[0].b).toBe('70.00'); // o commit aconteceu

    // 2) outra instancia (consumidor normal) recebe a reentrega
    const healthy = new WagerQueueConsumer(pool, sqs, useCase);
    for (let i = 0; i < 15; i++) {
      await healthy.pollOnce(1);
      const left = await pool.query(
        'SELECT 1 FROM inbox_messages WHERE message_id = $1 AND consumer_name = $2',
        [messageId, 'wager-transactions-consumer'],
      );
      if (left.rowCount === 1) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }

    const s = await pool.query(
      `SELECT balance::text AS balance,
              (SELECT COUNT(*)::int FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT') AS debits,
              (SELECT COUNT(*)::int FROM inbox_messages WHERE message_id = $2) AS inbox
         FROM wallets WHERE id = $1`,
      [w.id, messageId],
    );
    expect(s.rows[0].balance).toBe('70.00');
    expect(s.rows[0].debits).toBe(1);
    expect(s.rows[0].inbox).toBe(1);
  });
});

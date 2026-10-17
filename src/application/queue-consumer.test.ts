import { ReceiveMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
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
const consumer = new WagerQueueConsumer(pool, sqs, new SubmitWagerTransactionUseCase(pool));
const createWallet = new CreateWalletUseCase(pool);

afterAll(async () => {
  await pool.end();
});

async function drain(minimum: number): Promise<void> {
  let handled = 0;
  for (let i = 0; i < 15; i++) {
    const n = await consumer.pollOnce(1);
    handled += n;
    if (handled >= minimum && n === 0) return;
  }
}

function message(messageId: string, playerId: string, walletId: string, ext: string, amount: string) {
  return JSON.stringify({
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId: ext,
      idempotencyKey: `provider-a:${ext}`,
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    },
  });
}

async function send(body: string, group: string) {
  const urls = await sqs.ensureQueues();
  await sqs.client.send(
    new SendMessageCommand({
      QueueUrl: urls.inbound,
      MessageBody: body,
      MessageGroupId: group,
      MessageDeduplicationId: randomUUID(), // dedup do broker nao esconde a duplicata
    }),
  );
}

describe('consumidor SQS (Postgres e LocalStack reais)', () => {
  test('mensagem entregue duas vezes gera um unico debito', async () => {
    const playerId = randomUUID();
    const w = await createWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const messageId = `msg-${randomUUID()}`;
    const body = message(messageId, playerId, w.id, `ext-${randomUUID()}`, '30.00');
    await send(body, w.id);
    await send(body, w.id); // redelivery

    await drain(2);

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

  test('mensagem malformada vai para a DLQ e sai da fila principal', async () => {
    const marker = `bad-${randomUUID()}`;
    await send(`{"messageId":"${marker}","type":"Desconhecido"}`, 'invalid');
    await drain(1);

    const urls = await sqs.ensureQueues();
    let found = false;
    for (let i = 0; i < 10 && !found; i++) {
      const res = await sqs.client.send(
        new ReceiveMessageCommand({
          QueueUrl: urls.dlq,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          VisibilityTimeout: 0,
        }),
      );
      found = (res.Messages ?? []).some((m) => (m.Body ?? '').includes(marker));
    }
    expect(found).toBe(true);
  });
});

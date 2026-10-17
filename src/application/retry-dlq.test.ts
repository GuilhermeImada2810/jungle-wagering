import {
  CreateQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { SubmitWagerTransactionUseCase } from './submit-wager-transaction.use-case.js';
import { SqsService, type QueueUrls } from '../infrastructure/sqs/sqs.service.js';
import { WagerQueueConsumer } from '../infrastructure/sqs/wager-queue-consumer.js';

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  user: 'wagering',
  password: 'wagering',
  database: 'wagering',
  max: 5,
});

const suffix = randomUUID().slice(0, 8);
const DLQ = `retry-dlq-${suffix}.fifo`;
const MAIN = `retry-main-${suffix}.fifo`;
const base = 'http://localhost:4566/000000000000';

/** SqsService apontando para filas de teste (maxReceiveCount = 2). */
class TestSqs extends SqsService {
  override async ensureQueues(): Promise<QueueUrls> {
    const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };
    await this.client.send(new CreateQueueCommand({ QueueName: DLQ, Attributes: fifo }));
    await this.client.send(
      new CreateQueueCommand({
        QueueName: MAIN,
        Attributes: {
          ...fifo,
          VisibilityTimeout: '1',
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: `arn:aws:sqs:us-east-1:000000000000:${DLQ}`,
            maxReceiveCount: 2,
          }),
        },
      }),
    );
    return { inbound: `${base}/${MAIN}`, dlq: `${base}/${DLQ}`, events: `${base}/unused.fifo` };
  }
}

/** Falha transitoria permanente: o banco "esta fora" para este consumidor. */
class AlwaysFailing extends WagerQueueConsumer {
  attempts = 0;
  protected override async process(): Promise<never> {
    this.attempts += 1;
    throw new Error('postgres indisponivel');
  }
}

afterAll(async () => {
  await pool.end();
});

describe('retry transitorio ate a DLQ (LocalStack real)', () => {
  test('apos maxReceiveCount recebimentos a mensagem vai para a DLQ do SQS', async () => {
    const sqs = new TestSqs();
    const urls = await sqs.ensureQueues();
    const marker = `retry-${randomUUID()}`;
    await sqs.client.send(
      new SendMessageCommand({
        QueueUrl: urls.inbound,
        MessageGroupId: 'g1',
        MessageDeduplicationId: randomUUID(),
        MessageBody: JSON.stringify({
          messageId: marker,
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: {
            providerId: 'provider-a',
            externalTransactionId: marker,
            idempotencyKey: `provider-a:${marker}`,
            playerId: randomUUID(),
            walletId: randomUUID(),
            roundId: 'r',
            gameId: 'g',
            kind: 'BET',
            money: { amount: '10.00', currency: 'BRL' },
          },
        }),
      }),
    );

    const consumer = new AlwaysFailing(pool, sqs, new SubmitWagerTransactionUseCase(pool));
    for (let i = 0; i < 12; i++) {
      await consumer.pollOnce(1);
      await new Promise((r) => setTimeout(r, 1200));
    }
    expect(consumer.attempts).toBeGreaterThanOrEqual(2);

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
      found = (res.Messages ?? []).some((m: Message) => (m.Body ?? '').includes(marker));
    }
    expect(found).toBe(true);
  });
});

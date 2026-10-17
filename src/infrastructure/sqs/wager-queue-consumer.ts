import { createHash, randomUUID } from 'node:crypto';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import type { Pool } from 'pg';
import {
  IdempotencyConflictError,
  InvalidRequestError,
  SubmitWagerTransactionUseCase,
  WalletNotFoundError,
} from '../../application/submit-wager-transaction.use-case.js';
import { PG_POOL } from '../database/database.module.js';
import { withTransaction } from '../database/transaction.js';
import { SqsService, type QueueUrls } from './sqs.service.js';
import { parseWagerMessage, PermanentMessageError, type ParsedMessage } from './wager-message.js';

const CONSUMER_NAME = 'wager-transactions-consumer';

type Outcome = 'processed' | 'duplicate' | 'business-error';

@Injectable()
export class WagerQueueConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WagerQueueConsumer.name);
  private stopping = false;
  private loop: Promise<void> | undefined;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly sqs: SqsService,
    private readonly useCase: SubmitWagerTransactionUseCase,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.SQS_CONSUMER_DISABLED === 'true') return;
    this.loop = this.run();
  }

  /** SIGTERM: termina a mensagem em andamento, devolve as demais e para o loop. */
  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.loop;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.pollOnce(2);
      } catch (error) {
        this.log('sqs_poll_error', { error: (error as Error).message });
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  /** Recebe um lote e processa em ordem. Devolve quantas mensagens recebeu. */
  async pollOnce(waitSeconds = 2): Promise<number> {
    const urls = await this.sqs.ensureQueues();
    const res = await this.sqs.client.send(
      new ReceiveMessageCommand({
        QueueUrl: urls.inbound,
        MaxNumberOfMessages: 5,
        WaitTimeSeconds: waitSeconds,
        AttributeNames: ['All'],
      }),
    );
    const messages = res.Messages ?? [];
    for (const m of messages) await this.handle(m, urls);
    return messages.length;
  }

  private async handle(m: Message, urls: QueueUrls): Promise<void> {
    if (!m.ReceiptHandle) return;
    if (this.stopping) {
      await this.changeVisibility(m, urls.inbound, 0); // devolve a mensagem
      return;
    }
    const receiveCount = Number(m.Attributes?.ApproximateReceiveCount ?? '1');
    try {
      const parsed = parseWagerMessage(m.Body);
      const outcome = await this.process(parsed, m.Body ?? '');
      await this.ack(m, urls.inbound); // ack SO depois do commit
      this.log('sqs_message_handled', { messageId: parsed.messageId, outcome, receiveCount });
    } catch (error) {
      if (error instanceof PermanentMessageError) {
        try {
          await this.sendToDlq(m, urls.dlq);
          await this.ack(m, urls.inbound);
          this.log('sqs_message_dead_lettered', { reason: error.message });
          return;
        } catch (dlqError) {
          this.log('sqs_dlq_error', { error: (dlqError as Error).message });
        }
      }
      // transitorio: nao faz ack; backoff na visibilidade. Apos maxReceiveCount o SQS move para a DLQ.
      const delay = Math.min(2 ** receiveCount * 2, 300);
      await this.changeVisibility(m, urls.inbound, delay);
      this.log('sqs_message_retry', { receiveCount, delaySeconds: delay, error: (error as Error).message });
    }
  }

  /** Inbox + saldo + ledger + outbox na MESMA transacao. */
  protected async process(parsed: ParsedMessage, body: string): Promise<Outcome> {
    const hash = createHash('sha256').update(body).digest('hex');
    try {
      return await withTransaction(this.pool, async (db): Promise<Outcome> => {
        const ins = await db.query(
          `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, processed_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT DO NOTHING RETURNING message_id`,
          [CONSUMER_NAME, parsed.messageId, hash],
        );
        if (ins.rowCount === 0) return 'duplicate';
        await this.useCase.execute(parsed.input, db);
        return 'processed';
      });
    } catch (error) {
      if (error instanceof WalletNotFoundError) {
        throw new PermanentMessageError('wallet inexistente');
      }
      if (error instanceof InvalidRequestError || error instanceof IdempotencyConflictError) {
        // erro de negocio terminal: registra na inbox (nao reprocessar) e faz ack
        await this.pool.query(
          `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, processed_at)
           VALUES ($1, $2, $3, now()) ON CONFLICT DO NOTHING`,
          [CONSUMER_NAME, parsed.messageId, hash],
        );
        return 'business-error';
      }
      throw error;
    }
  }

  private async sendToDlq(m: Message, dlqUrl: string): Promise<void> {
    await this.sqs.client.send(
      new SendMessageCommand({
        QueueUrl: dlqUrl,
        MessageBody: m.Body ?? '',
        MessageGroupId: 'permanent-failure',
        MessageDeduplicationId: m.MessageId ?? randomUUID(),
      }),
    );
  }

  protected async ack(m: Message, queueUrl: string): Promise<void> {
    await this.sqs.client.send(
      new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }),
    );
  }

  private async changeVisibility(m: Message, queueUrl: string, seconds: number): Promise<void> {
    try {
      await this.sqs.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: m.ReceiptHandle,
          VisibilityTimeout: seconds,
        }),
      );
    } catch (error) {
      this.log('sqs_visibility_error', { error: (error as Error).message });
    }
  }

  // log estruturado: so ids e resultado, nunca o payload financeiro
  private log(event: string, fields: Record<string, unknown>): void {
    this.logger.log(JSON.stringify({ event, ...fields }));
  }
}



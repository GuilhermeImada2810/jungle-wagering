import {
  CreateQueueCommand,
  ListQueuesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Injectable, Logger } from '@nestjs/common';

export const QUEUE_NAMES = {
  inbound: 'wager-transactions.fifo',
  dlq: 'wager-transactions-dlq.fifo',
  events: 'wager-events.fifo',
};

export interface QueueUrls {
  inbound: string;
  dlq: string;
  events: string;
}

@Injectable()
export class SqsService {
  private readonly logger = new Logger(SqsService.name);
  private readonly endpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
  private readonly region = process.env.AWS_REGION ?? 'us-east-1';
  private urls: QueueUrls | undefined;

  readonly client = new SQSClient({
    region: this.region,
    endpoint: this.endpoint,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });

  private urlOf(name: string): string {
    return `${this.endpoint}/000000000000/${name}`;
  }

  /** Cria (idempotente) a DLQ, a fila de entrada com redrive para a DLQ e a fila de eventos. */
  async ensureQueues(): Promise<QueueUrls> {
    if (this.urls) return this.urls;
    const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };
    const maxReceive = Number(process.env.SQS_MAX_RECEIVE ?? 5);

    await this.client.send(
      new CreateQueueCommand({ QueueName: QUEUE_NAMES.dlq, Attributes: fifo }),
    );
    const dlqArn = `arn:aws:sqs:${this.region}:000000000000:${QUEUE_NAMES.dlq}`;
    await this.client.send(
      new CreateQueueCommand({
        QueueName: QUEUE_NAMES.inbound,
        Attributes: {
          ...fifo,
          VisibilityTimeout: '30',
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqArn,
            maxReceiveCount: maxReceive,
          }),
        },
      }),
    );
    await this.client.send(
      new CreateQueueCommand({ QueueName: QUEUE_NAMES.events, Attributes: fifo }),
    );

    this.urls = {
      inbound: this.urlOf(QUEUE_NAMES.inbound),
      dlq: this.urlOf(QUEUE_NAMES.dlq),
      events: this.urlOf(QUEUE_NAMES.events),
    };
    this.logger.log(JSON.stringify({ event: 'sqs_queues_ready', maxReceive }));
    return this.urls;
  }

  /** Usado pelo /health/ready. */
  async ping(): Promise<void> {
    await this.client.send(new ListQueuesCommand({ MaxResults: 1 }));
  }
}

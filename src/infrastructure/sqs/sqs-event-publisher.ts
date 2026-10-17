import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { Injectable } from '@nestjs/common';
import type { EventPublisher, PublishableEvent } from '../../application/event-publisher.js';
import { SqsService } from './sqs.service.js';

/** Publica os eventos da outbox na fila wager-events.fifo (at-least-once). */
@Injectable()
export class SqsEventPublisher implements EventPublisher {
  constructor(private readonly sqs: SqsService) {}

  async publish(event: PublishableEvent): Promise<void> {
    const urls = await this.sqs.ensureQueues();
    await this.sqs.client.send(
      new SendMessageCommand({
        QueueUrl: urls.events,
        MessageBody: JSON.stringify(event.payload),
        MessageGroupId: event.aggregateId,
        // dedup do broker e so otimizacao; o consumidor deduplica por eventId
        MessageDeduplicationId: event.id,
      }),
    );
  }
}

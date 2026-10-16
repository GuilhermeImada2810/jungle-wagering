import { Injectable, Logger } from '@nestjs/common';
import type { EventPublisher, PublishableEvent } from '../../application/event-publisher.js';

/** Publisher de desenvolvimento: registra o evento em log JSON. Troque por SQS/SNS em producao. */
@Injectable()
export class LogEventPublisher implements EventPublisher {
  private readonly logger = new Logger('OutboxPublisher');

  async publish(event: PublishableEvent): Promise<void> {
    this.logger.log(
      JSON.stringify({
        event: 'outbox_published',
        eventId: event.id,
        eventType: event.eventType,
        aggregateId: event.aggregateId,
      }),
    );
  }
}

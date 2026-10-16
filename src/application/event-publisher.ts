export interface PublishableEvent {
  id: string;
  eventType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');

export interface EventPublisher {
  publish(event: PublishableEvent): Promise<void>;
}

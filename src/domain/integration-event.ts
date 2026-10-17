import type { MoneyProps } from './money.js';

export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

export interface IntegrationEventProps<T> extends EventContext {
  aggregateId: string;
  data: T;
}

export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

/** Envelope base. eventType e version ficam no tipo, nao em string solta no call site. */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    if (props.causationId !== undefined) this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = props.data;
  }

  /** Envelope serializado gravado no payload da outbox. data carrega MoneyProps, nunca Money. */
  toJSON(): IntegrationEventEnvelope<T> {
    const out: IntegrationEventEnvelope<T> = {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
    if (this.causationId !== undefined) out.causationId = this.causationId;
    return out;
  }
}

export interface TransactionEventData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  kind: string;
  money: MoneyProps;
}

export interface ProcessedData extends TransactionEventData {
  balanceAfter: MoneyProps;
}
export interface RejectedData extends TransactionEventData {
  failureCode: string | undefined;
}
export interface PendingReferenceData extends TransactionEventData {
  referenceExternalTransactionId: string | undefined;
}
export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WagerTransactionProcessed extends IntegrationEvent<ProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;
  static from(aggregateId: string, data: ProcessedData, ctx: EventContext) {
    return new WagerTransactionProcessed({ ...ctx, aggregateId, data });
  }
}

export class WagerTransactionRejected extends IntegrationEvent<RejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;
  static from(aggregateId: string, data: RejectedData, ctx: EventContext) {
    return new WagerTransactionRejected({ ...ctx, aggregateId, data });
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<PendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;
  static from(aggregateId: string, data: PendingReferenceData, ctx: EventContext) {
    return new WagerTransactionPendingReference({ ...ctx, aggregateId, data });
  }
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;
  static from(aggregateId: string, data: WalletBalanceChangedData, ctx: EventContext) {
    return new WalletBalanceChanged({ ...ctx, aggregateId, data });
  }
}

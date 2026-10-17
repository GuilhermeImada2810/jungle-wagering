import { describe, expect, test } from 'bun:test';
import { InboxMessage } from './inbox-message.js';
import { WalletBalanceChanged } from './integration-event.js';
import { OutboxMessage } from './outbox-message.js';

const t0 = new Date('2026-10-17T12:00:00.000Z');
const m = (amount: string) => ({ amount, currency: 'BRL' });

const event = () =>
  WalletBalanceChanged.from(
    'w1',
    {
      walletId: 'w1',
      transactionId: 't1',
      direction: 'DEBIT',
      money: m('25.00'),
      balanceBefore: m('100.00'),
      balanceAfter: m('75.00'),
      walletVersion: 2,
    },
    { eventId: 'e1', correlationId: 't1', occurredAt: t0 },
  );

describe('IntegrationEvent', () => {
  test('envelope tem tipo e versao vindos da classe e data em MoneyProps', () => {
    const j = event().toJSON();
    expect(j.eventType).toBe('WalletBalanceChanged');
    expect(j.version).toBe(1);
    expect(j.occurredAt).toBe('2026-10-17T12:00:00.000Z');
    expect(j.data.balanceAfter).toEqual({ amount: '75.00', currency: 'BRL' });
    expect('causationId' in j).toBe(false);
  });
});

describe('OutboxMessage', () => {
  test('nasce pendente e devida', () => {
    const o = OutboxMessage.enqueue(event());
    expect(o.isPending()).toBe(true);
    expect(o.isDue(t0)).toBe(true);
    expect(o.attempts).toBe(0);
  });

  test('scheduleRetry incrementa attempts e aplica backoff exponencial', () => {
    const o = OutboxMessage.enqueue(event());
    o.scheduleRetry(t0);
    expect(o.attempts).toBe(1);
    expect(o.nextAttemptAt).toEqual(new Date(t0.getTime() + 2000));
    expect(o.isDue(t0)).toBe(false);
    o.scheduleRetry(t0);
    expect(o.nextAttemptAt).toEqual(new Date(t0.getTime() + 4000));
  });

  test('backoff tem teto de 5 minutos', () => {
    const o = OutboxMessage.enqueue(event());
    for (let i = 0; i < 20; i++) o.scheduleRetry(t0);
    expect(o.nextAttemptAt).toEqual(new Date(t0.getTime() + 300000));
  });

  test('markPublished tira da fila de pendentes', () => {
    const o = OutboxMessage.enqueue(event());
    o.markPublished(t0);
    expect(o.isPending()).toBe(false);
    expect(o.isDue(t0)).toBe(false);
  });
});

describe('InboxMessage', () => {
  test('recebe, marca processada uma unica vez', () => {
    const i = InboxMessage.receive({
      messageId: 'm1',
      consumerName: 'c',
      payloadHash: 'h',
      receivedAt: t0,
    });
    expect(i.isProcessed()).toBe(false);
    i.markProcessed(t0);
    expect(i.isProcessed()).toBe(true);
    expect(() => i.markProcessed(t0)).toThrow();
  });
});

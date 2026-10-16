import { describe, expect, test } from 'bun:test';
import { Money } from './money.js';
import { canonicalJson, computePayloadHash } from './payload-hash.js';

const base = {
  providerId: 'provider-a',
  externalTransactionId: 'tx-1',
  playerId: 'p1',
  walletId: 'w1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: 'BET',
  money: Money.from({ amount: '25.00', currency: 'BRL' }),
};

describe('canonicalJson', () => {
  test('ordena as chaves e ignora undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined } })).toBe('{"a":{"d":2},"b":1}');
  });
});

describe('computePayloadHash', () => {
  test('e deterministico', () => {
    expect(computePayloadHash(base)).toBe(computePayloadHash({ ...base }));
    expect(computePayloadHash(base)).toHaveLength(64);
  });

  test('"25" e "25.00" geram o mesmo hash', () => {
    const a = { ...base, money: Money.from({ amount: '25', currency: 'BRL' }) };
    expect(computePayloadHash(a)).toBe(computePayloadHash(base));
  });

  test('valor diferente muda o hash', () => {
    const b = { ...base, money: Money.from({ amount: '26.00', currency: 'BRL' }) };
    expect(computePayloadHash(b)).not.toBe(computePayloadHash(base));
  });

  test('qualquer campo de negocio diferente muda o hash', () => {
    expect(computePayloadHash({ ...base, kind: 'WIN' })).not.toBe(computePayloadHash(base));
    expect(computePayloadHash({ ...base, roundId: 'round-2' })).not.toBe(computePayloadHash(base));
    expect(computePayloadHash({ ...base, walletId: 'w2' })).not.toBe(computePayloadHash(base));
  });
});

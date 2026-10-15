import { describe, expect, test } from 'bun:test';
import { Money } from './money.js';

describe('Money.from', () => {
  test('aceita valor com 2 casas', () => {
    expect(Money.from({ amount: '25.00', currency: 'BRL' }).toString()).toBe('25.00');
  });

  test('normaliza para 2 casas', () => {
    expect(Money.from({ amount: '10', currency: 'BRL' }).toString()).toBe('10.00');
    expect(Money.from({ amount: '10.5', currency: 'BRL' }).toString()).toBe('10.50');
  });

  test('toJSON devolve amount e currency', () => {
    expect(Money.from({ amount: '25', currency: 'BRL' }).toJSON()).toEqual({
      amount: '25.00',
      currency: 'BRL',
    });
  });

  test.each(['', 'abc', 'NaN', 'Infinity', '1e5', '1.234', '-5.00', '.5', '5.', '1,50'])(
    'rejeita "%s"',
    (amount) => {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow();
    },
  );
});

describe('Money.add', () => {
  test('soma sem erro de ponto flutuante', () => {
    const a = Money.from({ amount: '0.10', currency: 'BRL' });
    const b = Money.from({ amount: '0.20', currency: 'BRL' });
    expect(a.add(b).toString()).toBe('0.30');
  });

  test('rejeita somar moedas diferentes', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '10.00', currency: 'USD' });
    expect(() => brl.add(usd)).toThrow();
  });
});

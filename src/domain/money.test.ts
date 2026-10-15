import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, Money } from './money.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

describe('Money.from', () => {
  test('aceita valor com 2 casas', () => {
    expect(brl('25.00').toString()).toBe('25.00');
  });

  test('normaliza para 2 casas', () => {
    expect(brl('10').toString()).toBe('10.00');
    expect(brl('10.5').toString()).toBe('10.50');
  });

  test('aceita zero', () => {
    expect(brl('0.00').toString()).toBe('0.00');
  });

  test('toJSON devolve amount e currency', () => {
    expect(brl('25').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  test.each(['', 'abc', 'NaN', 'Infinity', '1e5', '1.234', '-5.00', '.5', '5.', '1,50'])(
    'rejeita "%s"',
    (amount) => {
      expect(() => brl(amount)).toThrow();
    },
  );
});

describe('Money.zero', () => {
  test('cria zero na moeda informada', () => {
    const z = Money.zero('BRL');
    expect(z.toString()).toBe('0.00');
    expect(z.currency).toBe('BRL');
    expect(z.isZero()).toBe(true);
  });
});

describe('Money.add', () => {
  test('soma sem erro de ponto flutuante', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
  });

  test('rejeita somar moedas diferentes', () => {
    expect(() => brl('10.00').add(usd('10.00'))).toThrow(CurrencyMismatchError);
  });

  test('não altera o original (imutável)', () => {
    const a = brl('10.00');
    a.add(brl('5.00'));
    expect(a.toString()).toBe('10.00');
  });
});

describe('Money.subtract', () => {
  test('subtrai valores', () => {
    expect(brl('10.00').subtract(brl('3.50')).toString()).toBe('6.50');
  });

  test('permite resultado negativo', () => {
    expect(brl('10.00').subtract(brl('15.00')).toString()).toBe('-5.00');
  });

  test('rejeita subtrair moedas diferentes', () => {
    expect(() => brl('10.00').subtract(usd('10.00'))).toThrow(CurrencyMismatchError);
  });
});

describe('Money.negate', () => {
  test('inverte o sinal', () => {
    expect(brl('5.00').negate().toString()).toBe('-5.00');
    expect(brl('5.00').negate().negate().toString()).toBe('5.00');
  });
});

describe('Money consultas', () => {
  test('isZero', () => {
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.01').isZero()).toBe(false);
  });

  test('isPositive e isNegative', () => {
    expect(brl('1.00').isPositive()).toBe(true);
    expect(brl('0.00').isPositive()).toBe(false);
    expect(brl('1.00').negate().isNegative()).toBe(true);
    expect(brl('0.00').isNegative()).toBe(false);
  });

  test('isLessThan', () => {
    expect(brl('1.00').isLessThan(brl('2.00'))).toBe(true);
    expect(brl('2.00').isLessThan(brl('2.00'))).toBe(false);
    expect(() => brl('1.00').isLessThan(usd('2.00'))).toThrow(CurrencyMismatchError);
  });

  test('equals considera valor e moeda', () => {
    expect(brl('10').equals(brl('10.00'))).toBe(true);
    expect(brl('10.00').equals(brl('10.01'))).toBe(false);
    expect(brl('10.00').equals(usd('10.00'))).toBe(false);
  });
});

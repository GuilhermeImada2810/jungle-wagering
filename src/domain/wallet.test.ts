import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, Money } from './money.js';
import { LedgerDirection } from './wallet-ledger-entry.js';
import { InsufficientFundsError, InvalidAmountError, Wallet } from './wallet.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
const at = new Date('2026-10-16T12:00:00.000Z');

const openWallet = (initial = '100.00') =>
  Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(initial), now: at });

const move = (money: Money, n = 1) => ({
  entryId: `e${n}`,
  transactionId: `t${n}`,
  money,
  at,
});

describe('Wallet.open', () => {
  test('nasce com version 1 e o saldo inicial', () => {
    const w = openWallet();
    expect(w.version).toBe(1);
    expect(w.balance.toString()).toBe('100.00');
    expect(w.currency).toBe('BRL');
  });
});

describe('Wallet.debit', () => {
  test('debita, devolve lancamento e incrementa a version', () => {
    const w = openWallet();
    const entry = w.debit(move(brl('25.00')));
    expect(w.balance.toString()).toBe('75.00');
    expect(w.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('75.00');
  });

  test('rejeita saldo insuficiente sem alterar nada', () => {
    const w = openWallet('100.00');
    expect(() => w.debit(move(brl('100.01')))).toThrow(InsufficientFundsError);
    expect(w.balance.toString()).toBe('100.00');
    expect(w.version).toBe(1);
  });

  test('permite debitar exatamente o saldo', () => {
    const w = openWallet('80.00');
    w.debit(move(brl('80.00')));
    expect(w.balance.toString()).toBe('0.00');
  });

  test('cenario: duas apostas de 80 com saldo 100, so a primeira passa', () => {
    const w = openWallet('100.00');
    w.debit(move(brl('80.00'), 1));
    expect(() => w.debit(move(brl('80.00'), 2))).toThrow(InsufficientFundsError);
    expect(w.balance.toString()).toBe('20.00');
  });

  test('rejeita moeda diferente', () => {
    const w = openWallet();
    expect(() => w.debit(move(usd('10.00')))).toThrow(CurrencyMismatchError);
  });

  test('rejeita valor zero', () => {
    const w = openWallet();
    expect(() => w.debit(move(brl('0.00')))).toThrow(InvalidAmountError);
  });
});

describe('Wallet.credit', () => {
  test('credita, devolve lancamento e incrementa a version', () => {
    const w = openWallet();
    const entry = w.credit(move(brl('50.00')));
    expect(w.balance.toString()).toBe('150.00');
    expect(w.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test('rejeita moeda diferente', () => {
    const w = openWallet();
    expect(() => w.credit(move(usd('10.00')))).toThrow(CurrencyMismatchError);
  });
});

describe('Wallet.rehydrate', () => {
  test('reconstroi o estado sem alterar a version', () => {
    const w = Wallet.rehydrate({
      id: 'w9',
      playerId: 'p9',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: at,
      updatedAt: at,
    });
    expect(w.version).toBe(7);
    expect(w.balance.toString()).toBe('42.00');
  });
});

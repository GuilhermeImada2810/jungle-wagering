import { describe, expect, test } from 'bun:test';
import { Money } from './money.js';
import {
  LedgerDirection,
  LedgerEntryInvalidError,
  WalletLedgerEntry,
} from './wallet-ledger-entry.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

const base = {
  id: 'e1',
  walletId: 'w1',
  transactionId: 't1',
  createdAt: new Date('2026-10-16T12:00:00.000Z'),
};

describe('WalletLedgerEntry.create', () => {
  test('aceita debito consistente', () => {
    const e = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('25.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('75.00'),
    });
    expect(e.isBalanced()).toBe(true);
  });

  test('aceita credito consistente', () => {
    const e = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('25.00'),
      balanceBefore: brl('75.00'),
      balanceAfter: brl('100.00'),
    });
    expect(e.isBalanced()).toBe(true);
  });

  test('rejeita aritmetica errada', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('25.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('80.00'),
      }),
    ).toThrow(LedgerEntryInvalidError);
  });

  test('rejeita valor zero', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('0.00'),
        balanceBefore: brl('10.00'),
        balanceAfter: brl('10.00'),
      }),
    ).toThrow(LedgerEntryInvalidError);
  });

  test('rejeita saldo final negativo', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('30.00'),
        balanceBefore: brl('10.00'),
        balanceAfter: brl('10.00').subtract(brl('30.00')),
      }),
    ).toThrow(LedgerEntryInvalidError);
  });
});

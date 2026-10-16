import { Money } from './money.js';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export class LedgerEntryInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerEntryInvalidError';
  }
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new LedgerEntryInvalidError('o valor do lancamento deve ser positivo');
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new LedgerEntryInvalidError('saldo nao pode ser negativo');
    }

    const entry = WalletLedgerEntry.build(props);
    if (!entry.isBalanced()) {
      throw new LedgerEntryInvalidError('balanceBefore +/- money deve ser igual a balanceAfter');
    }
    return entry;
  }

  /** Reconstrucao a partir da persistencia: nao revalida. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return WalletLedgerEntry.build(state);
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  private static build(p: CreateLedgerEntryProps): WalletLedgerEntry {
    return new WalletLedgerEntry(
      p.id,
      p.walletId,
      p.transactionId,
      p.direction,
      p.money,
      p.balanceBefore,
      p.balanceAfter,
      p.createdAt,
    );
  }
}

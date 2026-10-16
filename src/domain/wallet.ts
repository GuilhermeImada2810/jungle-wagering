import { CurrencyMismatchError, Money } from './money.js';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.js';

export class InsufficientFundsError extends Error {
  constructor(balance: string, requested: string) {
    super(`saldo insuficiente: saldo ${balance}, solicitado ${requested}`);
    this.name = 'InsufficientFundsError';
  }
}

export class InvalidAmountError extends Error {
  constructor() {
    super('o valor da movimentacao deve ser positivo');
    this.name = 'InvalidAmountError';
  }
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  now?: Date;
}

export interface MovementProps {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidAmountError();
    }
    const now = props.now ?? new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  /** Reconstrucao a partir da persistencia: nao revalida. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    this.assertPositive(props.money);
    if (this._balance.isLessThan(props.money)) {
      throw new InsufficientFundsError(this._balance.toString(), props.money.toString());
    }
    return this.apply(LedgerDirection.Debit, this._balance.subtract(props.money), props);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    this.assertPositive(props.money);
    return this.apply(LedgerDirection.Credit, this._balance.add(props.money), props);
  }

  private apply(
    direction: LedgerDirection,
    newBalance: Money,
    props: MovementProps,
  ): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: this._balance,
      balanceAfter: newBalance,
      createdAt: props.at,
    });
    this._balance = newBalance;
    this._version += 1;
    this._updatedAt = props.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }

  private assertPositive(money: Money): void {
    if (!money.isPositive()) {
      throw new InvalidAmountError();
    }
  }
}

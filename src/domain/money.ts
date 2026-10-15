import { Decimal } from 'decimal.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (!AMOUNT_PATTERN.test(props.amount)) {
      throw new Error('amount inválido');
    }

    return new Money(new Decimal(props.amount), props.currency);
  }

  toString(): string {
    return this.value.toFixed(2);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }
}

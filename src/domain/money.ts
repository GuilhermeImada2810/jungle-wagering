import { Decimal } from 'decimal.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (props.amount.trim() === '') {
      throw new Error('amount não pode ser vazio');
    }

    return new Money(new Decimal(props.amount), props.currency);
  }
}

import { EntitySchema } from '@mikro-orm/core';

export class WalletOrmEntity {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;

  constructor(
    id: string,
    playerId: string,
    currency: string,
    balance: string,
    version: number,
    createdAt: Date,
    updatedAt: Date,
  ) {
    this.id = id;
    this.playerId = playerId;
    this.currency = currency;
    this.balance = balance;
    this.version = version;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }
}

export const WalletSchema = new EntitySchema<WalletOrmEntity>({
  class: WalletOrmEntity,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    currency: { type: 'string', length: 3 },
    balance: { type: 'string', columnType: 'numeric(18,2)' },
    version: { type: 'integer' },
    createdAt: { type: 'Date', fieldName: 'created_at' },
    updatedAt: { type: 'Date', fieldName: 'updated_at' },
  },
});

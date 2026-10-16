import { Global, Module } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { WalletSchema } from '../persistence/wallet.orm-entity.js';

export const ORM = Symbol('ORM');

@Global()
@Module({
  providers: [
    {
      provide: ORM,
      useFactory: async (): Promise<MikroORM> =>
        MikroORM.init({
          host: process.env.DB_HOST ?? 'localhost',
          port: Number(process.env.DB_PORT ?? 5432),
          user: process.env.DB_USER ?? 'wagering',
          password: process.env.DB_PASSWORD ?? 'wagering',
          dbName: process.env.DB_NAME ?? 'wagering',
          entities: [WalletSchema],
        }),
    },
  ],
  exports: [ORM],
})
export class DatabaseModule {}

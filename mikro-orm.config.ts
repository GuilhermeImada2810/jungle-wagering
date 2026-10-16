import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { WalletSchema } from './src/infrastructure/persistence/wallet.orm-entity.js';

export default defineConfig({
  host: 'localhost',
  port: 5432,
  user: 'wagering',
  password: 'wagering',
  dbName: 'wagering',
  entities: [WalletSchema],
  extensions: [Migrator],
  migrations: {
    path: './src/migrations',
    glob: '!(*.d).{js,ts}',
    transactional: true,
    allOrNothing: true,
  },
});

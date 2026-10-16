import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { CreateWalletUseCase } from './application/create-wallet.use-case.js';
import { QueryService } from './application/query.service.js';
import { SubmitWagerTransactionUseCase } from './application/submit-wager-transaction.use-case.js';
import { DatabaseModule } from './infrastructure/database/database.module.js';
import { HealthController } from './health/health.controller.js';
import { QueryController } from './api/query.controller.js';
import { WalletsController } from './api/wallets.controller.js';
import { WageringController } from './api/wagering.controller.js';

@Module({
  imports: [DatabaseModule],
  controllers: [
    AppController,
    HealthController,
    WalletsController,
    WageringController,
    QueryController,
  ],
  providers: [AppService, CreateWalletUseCase, SubmitWagerTransactionUseCase, QueryService],
})
export class AppModule {}

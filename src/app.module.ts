import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { CreateWalletUseCase } from './application/create-wallet.use-case.js';
import { EVENT_PUBLISHER } from './application/event-publisher.js';
import { OutboxDispatcher } from './application/outbox-dispatcher.js';
import { OutboxScheduler } from './application/outbox-scheduler.js';
import { QueryService } from './application/query.service.js';
import { ReconcileWalletUseCase } from './application/reconcile-wallet.use-case.js';
import { ReferenceReprocessor } from './application/reference-reprocessor.js';
import { SubmitWagerTransactionUseCase } from './application/submit-wager-transaction.use-case.js';
import { DatabaseModule } from './infrastructure/database/database.module.js';
import { LogEventPublisher } from './infrastructure/log-event-publisher.js';
import { HealthController } from './health/health.controller.js';
import { QueryController } from './api/query.controller.js';
import { ReconciliationController } from './api/reconciliation.controller.js';
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
    ReconciliationController,
  ],
  providers: [
    AppService,
    CreateWalletUseCase,
    SubmitWagerTransactionUseCase,
    QueryService,
    ReconcileWalletUseCase,
    ReferenceReprocessor,
    OutboxDispatcher,
    OutboxScheduler,
    { provide: EVENT_PUBLISHER, useClass: LogEventPublisher },
  ],
})
export class AppModule {}

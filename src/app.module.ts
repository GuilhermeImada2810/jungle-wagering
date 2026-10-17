import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth/auth.guard.js';
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
import { SqsEventPublisher } from './infrastructure/sqs/sqs-event-publisher.js';
import { SqsService } from './infrastructure/sqs/sqs.service.js';
import { WagerQueueConsumer } from './infrastructure/sqs/wager-queue-consumer.js';
import { HealthController } from './health/health.controller.js';
import { QueryController } from './api/query.controller.js';
import { ReconciliationController } from './api/reconciliation.controller.js';
import { WalletsController } from './api/wallets.controller.js';
import { WageringController } from './api/wagering.controller.js';

@Module({
  imports: [DatabaseModule],
  controllers: [
    HealthController,
    WalletsController,
    WageringController,
    QueryController,
    ReconciliationController,
  ],
  providers: [
    CreateWalletUseCase,
    SubmitWagerTransactionUseCase,
    QueryService,
    ReconcileWalletUseCase,
    ReferenceReprocessor,
    OutboxDispatcher,
    OutboxScheduler,
    SqsService,
    WagerQueueConsumer,
    {
      provide: EVENT_PUBLISHER,
      useClass: process.env.EVENT_PUBLISHER === 'log' ? LogEventPublisher : SqsEventPublisher,
    },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}

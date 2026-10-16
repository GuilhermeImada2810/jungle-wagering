import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { CreateWalletUseCase } from './application/create-wallet.use-case.js';
import { DatabaseModule } from './infrastructure/database/database.module.js';
import { HealthController } from './health/health.controller.js';
import { WalletsController } from './api/wallets.controller.js';

@Module({
  imports: [DatabaseModule],
  controllers: [AppController, HealthController, WalletsController],
  providers: [AppService, CreateWalletUseCase],
})
export class AppModule {}

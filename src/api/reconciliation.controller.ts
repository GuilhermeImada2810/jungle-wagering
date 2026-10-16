import {
  BadRequestException,
  Controller,
  HttpCode,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import {
  ReconcileWalletUseCase,
  type ReconciliationResult,
} from '../application/reconcile-wallet.use-case.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('wallets')
export class ReconciliationController {
  constructor(private readonly reconcile: ReconcileWalletUseCase) {}

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async run(@Param('walletId') walletId: string): Promise<ReconciliationResult> {
    if (!UUID.test(walletId)) throw new BadRequestException('walletId deve ser UUID');
    const result = await this.reconcile.execute(walletId.toLowerCase());
    if (!result) throw new NotFoundException('wallet nao encontrada');
    return result;
  }
}

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CreateWalletUseCase,
  WalletAlreadyExistsError,
  type WalletView,
} from '../application/create-wallet.use-case.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('wallets')
export class WalletsController {
  constructor(private readonly createWallet: CreateWalletUseCase) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown): Promise<WalletView> {
    const b = body as {
      playerId?: unknown;
      initialBalance?: { amount?: unknown; currency?: unknown };
    };
    if (typeof b?.playerId !== 'string' || !UUID.test(b.playerId)) {
      throw new BadRequestException('playerId invalido (UUID esperado)');
    }
    const amount = b.initialBalance?.amount;
    const currency = b.initialBalance?.currency;
    if (typeof amount !== 'string' || typeof currency !== 'string') {
      throw new BadRequestException('initialBalance.amount e currency devem ser strings');
    }

    try {
      return await this.createWallet.execute({
        playerId: b.playerId,
        initialBalance: { amount, currency },
      });
    } catch (error) {
      if (error instanceof WalletAlreadyExistsError) {
        throw new ConflictException(error.message);
      }
      if (error instanceof Error && error.message === 'amount inválido') {
        throw new BadRequestException('amount invalido');
      }
      if ((error as { code?: string }).code === '23514') {
        throw new BadRequestException('dados violam uma regra do banco (ex.: moeda invalida)');
      }
      throw new ServiceUnavailableException('falha transitoria, tente novamente');
    }
  }
}

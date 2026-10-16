import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  HttpCode,
  Logger,
  NotFoundException,
  Post,
  Res,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  IdempotencyConflictError,
  InvalidRequestError,
  SubmitWagerTransactionUseCase,
  WalletNotFoundError,
  type SubmitInput,
  type SubmitResult,
} from '../application/submit-wager-transaction.use-case.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200) {
    throw new BadRequestException(`${field} invalido`);
  }
  return value;
}

@Controller('wagering')
export class WageringController {
  private readonly logger = new Logger(WageringController.name);

  constructor(private readonly submit: SubmitWagerTransactionUseCase) {}

  /**
   * 200 processada | 202 aguardando referencia | 400 payload invalido | 404 wallet
   * 409 conflito de idempotencia | 422 rejeitada por regra de negocio | 503 transitorio
   */
  @Post('transactions')
  @HttpCode(200)
  async create(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: { status(code: number): unknown },
  ): Promise<SubmitResult> {
    const key = text(idempotencyKey, 'Idempotency-Key');
    const b = (body ?? {}) as Record<string, unknown>;
    const money = (b.money ?? {}) as Record<string, unknown>;

    const playerId = text(b.playerId, 'playerId');
    const walletId = text(b.walletId, 'walletId');
    if (!UUID.test(playerId) || !UUID.test(walletId)) {
      throw new BadRequestException('playerId e walletId devem ser UUID');
    }
    const input: SubmitInput = {
      idempotencyKey: key,
      providerId: text(b.providerId, 'providerId'),
      externalTransactionId: text(b.externalTransactionId, 'externalTransactionId'),
      playerId: playerId.toLowerCase(),
      walletId: walletId.toLowerCase(),
      roundId: text(b.roundId, 'roundId'),
      gameId: text(b.gameId, 'gameId'),
      kind: text(b.kind, 'kind'),
      money: {
        amount: text(money.amount, 'money.amount'),
        currency: text(money.currency, 'money.currency'),
      },
    };
    if (b.referenceExternalTransactionId !== undefined) {
      input.referenceExternalTransactionId = text(
        b.referenceExternalTransactionId,
        'referenceExternalTransactionId',
      );
    }

    let result: SubmitResult;
    try {
      result = await this.submit.execute(input);
    } catch (error) {
      if (error instanceof InvalidRequestError) throw new BadRequestException(error.message);
      if (error instanceof IdempotencyConflictError) throw new ConflictException(error.message);
      if (error instanceof WalletNotFoundError) throw new NotFoundException(error.message);
      // nunca logar o payload financeiro, so a mensagem
      this.logger.error(`falha transitoria: ${(error as Error).message}`);
      throw new ServiceUnavailableException('falha transitoria, pode reenviar com a mesma key');
    }

    if (result.status === 'REJECTED') throw new UnprocessableEntityException(result);
    if (result.status === 'PENDING_REFERENCE') res.status(202);
    return result;
  }
}

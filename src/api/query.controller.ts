import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { InvalidCursorError, QueryService } from '../application/query.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(value: string, field: string): string {
  if (!UUID.test(value)) throw new BadRequestException(`${field} deve ser UUID`);
  return value.toLowerCase();
}

@Controller()
export class QueryController {
  constructor(private readonly queries: QueryService) {}

  @Get('wallets/:walletId')
  async wallet(@Param('walletId') walletId: string) {
    const w = await this.queries.getWallet(uuid(walletId, 'walletId'));
    if (!w) throw new NotFoundException('wallet nao encontrada');
    return w;
  }

  @Get('wallets/:walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const id = uuid(walletId, 'walletId');
    let limit = 50;
    if (limitRaw !== undefined) {
      if (!/^\d+$/.test(limitRaw)) throw new BadRequestException('limit invalido');
      limit = Math.min(Math.max(Number(limitRaw), 1), 200);
    }
    if (!(await this.queries.getWallet(id))) throw new NotFoundException('wallet nao encontrada');
    try {
      return await this.queries.getLedger(id, cursor, limit);
    } catch (error) {
      if (error instanceof InvalidCursorError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  @Get('wagering/transactions/:transactionId')
  async transaction(@Param('transactionId') transactionId: string) {
    const t = await this.queries.getTransactionById(uuid(transactionId, 'transactionId'));
    if (!t) throw new NotFoundException('transacao nao encontrada');
    return t;
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byExternal(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const t = await this.queries.getTransactionByExternal(providerId, externalTransactionId);
    if (!t) throw new NotFoundException('transacao nao encontrada');
    return t;
  }
}

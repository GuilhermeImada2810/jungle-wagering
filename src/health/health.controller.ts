import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../infrastructure/database/database.module.js';
import { SqsService } from '../infrastructure/sqs/sqs.service.js';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly sqs: SqsService,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    const [pg, sqs] = await Promise.allSettled([this.pool.query('SELECT 1'), this.sqs.ping()]);
    const body = {
      postgres: pg.status === 'fulfilled' ? 'up' : 'down',
      sqs: sqs.status === 'fulfilled' ? 'up' : 'down',
    };
    if (body.postgres === 'up' && body.sqs === 'up') return { status: 'ok', ...body };
    throw new ServiceUnavailableException({ status: 'unavailable', ...body });
  }
}

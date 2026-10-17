import { Controller, Get, Header, Inject, OnModuleInit } from '@nestjs/common';
import { OutboxDispatcher } from '../application/outbox-dispatcher.js';
import { metrics } from '../infrastructure/metrics.js';

@Controller()
export class MetricsController implements OnModuleInit {
  constructor(@Inject(OutboxDispatcher) private readonly outbox: OutboxDispatcher) {}

  onModuleInit(): void {
    metrics.gauge('wager_outbox_lag_seconds', () => this.outbox.lagSeconds());
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  async render(): Promise<string> {
    return metrics.render();
  }
}

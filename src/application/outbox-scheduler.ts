import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { OutboxDispatcher } from './outbox-dispatcher.js';
import { ReferenceReprocessor } from './reference-reprocessor.js';

@Injectable()
export class OutboxScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxScheduler.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly dispatcher: OutboxDispatcher,
    private readonly reprocessor: ReferenceReprocessor,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.OUTBOX_DISABLED === 'true') return;
    this.timer = setInterval(() => void this.tick(), Number(process.env.OUTBOX_INTERVAL_MS ?? 1000));
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 50));
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.reprocessor.processDue();
      await this.dispatcher.dispatchBatch();
    } catch (error) {
      this.logger.error(`falha no ciclo de background: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

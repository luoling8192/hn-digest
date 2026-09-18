import { ConcurrentRunError, errorCode } from '../errors.js';
import type { Logger } from '../logger.js';
import type { DigestService } from './digest-service.js';

export class DigestScheduler {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;

  constructor(
    private readonly service: DigestService,
    private readonly intervalMs: number,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.service.automaticPublishingEnabled()) {
      try {
        await this.service.runCycle();
      } catch (error) {
        if (!(error instanceof ConcurrentRunError)) {
          this.logger.error('cycle_failed', { code: errorCode(error) });
        }
      }
    }
    if (!this.stopped) {
      this.timer = setTimeout(() => void this.tick(), this.intervalMs);
      this.timer.unref();
    }
  }
}

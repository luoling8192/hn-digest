import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { errorCode } from '../errors.js';
import type { Logger } from '../logger.js';
import { readingUpdateSchema, type ReadingService, type ReadingTransport } from './service.js';
import type { ReadingStore } from './store.js';

export class ReadingPoller {
  private abort = new AbortController();
  private running: Promise<void> | null = null;
  private lastPollAt: string | null = null;

  constructor(
    private readonly store: ReadingStore,
    private readonly transport: ReadingTransport,
    private readonly service: ReadingService,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = this.run();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.running;
  }

  status() {
    return {
      enabled: true,
      polling: this.running !== null && !this.abort.signal.aborted,
      lastPollAt: this.lastPollAt,
    };
  }

  async pollOnce(signal?: AbortSignal): Promise<void> {
    const raw = await this.transport.call(
      'getUpdates',
      {
        offset: this.store.offset,
        timeout: 20,
        limit: 25,
        allowed_updates: ['message', 'callback_query'],
      },
      signal,
    );
    const updates = z.array(z.object({ update_id: z.number().int() }).passthrough()).parse(raw);
    this.lastPollAt = new Date().toISOString();
    for (const rawUpdate of updates) {
      if (signal?.aborted) return;
      if (rawUpdate.update_id < this.store.offset) continue;
      // Claim before effects: an interrupted send must not be replayed after restart.
      this.store.offset = rawUpdate.update_id + 1;
      const parsed = readingUpdateSchema.safeParse(rawUpdate);
      if (!parsed.success || !this.service.accepts(parsed.data)) continue;
      try {
        await this.service.handle(parsed.data);
      } catch (error) {
        this.logger.error('reading_update_failed', {
          updateId: rawUpdate.update_id,
          code: errorCode(error),
        });
        try {
          await this.service.reportFailure();
        } catch (notificationError) {
          this.logger.warn('reading_error_notification_failed', {
            code: errorCode(notificationError),
          });
        }
      }
    }
  }

  private async run(): Promise<void> {
    this.logger.info('reading_bot_started');
    while (!this.abort.signal.aborted) {
      try {
        await this.pollOnce(this.abort.signal);
      } catch (error) {
        if (this.abort.signal.aborted) break;
        this.logger.warn('reading_poll_failed', { code: errorCode(error) });
        try {
          await delay(5000, undefined, { signal: this.abort.signal });
        } catch {
          break;
        }
      }
    }
  }
}

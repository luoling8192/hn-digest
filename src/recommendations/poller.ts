import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { errorCode } from '../errors.js';
import type { Logger } from '../logger.js';
import {
  type ReadingService,
  type ReadingTransport,
  type ReadingUpdate,
  readingUpdateSchema,
} from './service.js';
import type { ReadingStore } from './store.js';

const maxPendingReadingUpdates = 25;

export class ReadingPoller {
  private abort = new AbortController();
  private running: Promise<void> | null = null;
  private lastPollAt: string | null = null;
  private normalTail: Promise<void> = Promise.resolve();
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly store: ReadingStore,
    private readonly transport: ReadingTransport,
    private readonly service: Pick<
      ReadingService,
      'accepts' | 'isImmediate' | 'handle' | 'reportFailure'
    >,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = this.run();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.running;
    await this.normalTail;
  }

  status() {
    return {
      enabled: true,
      polling: this.running !== null && !this.abort.signal.aborted,
      lastPollAt: this.lastPollAt,
    };
  }

  async pollOnce(signal?: AbortSignal): Promise<void> {
    await this.poll(signal);
    await this.normalTail;
  }

  private async poll(signal?: AbortSignal): Promise<void> {
    // A saturated normal queue pauses fetching until one operation finishes.
    while (this.pending.size >= maxPendingReadingUpdates) {
      if (signal?.aborted) return;
      await Promise.race(this.pending);
    }
    if (signal?.aborted) return;
    const limit = maxPendingReadingUpdates - this.pending.size;
    const raw = await this.transport.call(
      'getUpdates',
      {
        offset: this.store.offset,
        timeout: 20,
        limit,
        allowed_updates: ['message', 'callback_query'],
      },
      signal,
    );
    const updates = z
      .array(z.object({ update_id: z.number().int() }).passthrough())
      .max(limit)
      .parse(raw);
    this.lastPollAt = new Date().toISOString();
    for (const rawUpdate of updates) {
      if (signal?.aborted) return;
      if (rawUpdate.update_id < this.store.offset) continue;
      // Claim before effects: an interrupted send must not be replayed after restart.
      this.store.offset = rawUpdate.update_id + 1;
      const parsed = readingUpdateSchema.safeParse(rawUpdate);
      if (!parsed.success || !this.service.accepts(parsed.data)) continue;
      if (this.service.isImmediate(parsed.data)) await this.handle(parsed.data);
      else this.enqueue(parsed.data);
    }
  }

  private enqueue(update: ReadingUpdate): void {
    const operation = this.normalTail.then(() => this.handle(update));
    this.normalTail = operation;
    this.pending.add(operation);
    void operation.then(
      () => {
        this.pending.delete(operation);
      },
      () => {
        this.pending.delete(operation);
      },
    );
  }

  private async handle(update: ReadingUpdate): Promise<void> {
    try {
      await this.service.handle(update);
    } catch (error) {
      this.logger.error('reading_update_failed', {
        updateId: update.update_id,
        code: errorCode(error),
      });
      try {
        await this.service.reportFailure(update);
      } catch (notificationError) {
        this.logger.warn('reading_error_notification_failed', {
          code: errorCode(notificationError),
        });
      }
    }
  }

  private async run(): Promise<void> {
    this.logger.info('reading_bot_started');
    while (!this.abort.signal.aborted) {
      try {
        await this.poll(this.abort.signal);
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

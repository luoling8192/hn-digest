import { z } from 'zod';
import type { Config } from '../config.js';
import type { Draft, Page } from '../domain.js';
import { DeliveryRejectedError, DeliveryUncertainError } from '../errors.js';
import { renderTelegramDelivery } from '../presentation.js';
import type { FeedbackCounts } from '../recommendations/store.js';

const envelopeSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error_code: z.number().int().optional(),
  description: z.string().optional(),
});

const messageSchema = z.object({ message_id: z.number().int().positive() });

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class TelegramClient {
  private readonly messageUpdates = new Map<string, Promise<unknown>>();
  private readonly feedbackCounts: (storyId: number) => FeedbackCounts;

  constructor(
    private readonly config: Pick<Config, 'TELEGRAM_BOT_TOKEN' | 'TELEGRAM_CHAT_ID'> &
      Partial<Pick<Config, 'TELEGRAM_OWNER_ID'>>,
    private readonly fetchImplementation: FetchLike = fetch,
    feedbackCounts?: (storyId: number) => FeedbackCounts,
  ) {
    if (config.TELEGRAM_OWNER_ID !== undefined && !feedbackCounts) {
      throw new Error('A feedback count provider is required when reading is configured');
    }
    this.feedbackCounts = feedbackCounts ?? (() => ({ likes: 0, saves: 0 }));
  }

  async send(draft: Draft, page: Page): Promise<number> {
    const delivery = renderTelegramDelivery(
      draft,
      page.url,
      this.config.TELEGRAM_OWNER_ID !== undefined,
      this.feedbackCounts(draft.story.id),
    );
    const result = await this.call('sendMessage', {
      chat_id: this.config.TELEGRAM_CHAT_ID,
      ...delivery.payload,
    });
    const parsed = messageSchema.safeParse(result);
    if (!parsed.success) {
      throw new DeliveryUncertainError('Telegram accepted a message without returning its ID');
    }
    return parsed.data.message_id;
  }

  async edit(draft: Draft, page: Page, messageId: number): Promise<void> {
    await this.enqueueMessageUpdate(this.config.TELEGRAM_CHAT_ID, messageId, async () => {
      const delivery = renderTelegramDelivery(
        draft,
        page.url,
        this.config.TELEGRAM_OWNER_ID !== undefined,
        this.feedbackCounts(draft.story.id),
      );
      await this.request('editMessageText', {
        chat_id: this.config.TELEGRAM_CHAT_ID,
        message_id: messageId,
        ...delivery.payload,
        reply_markup: delivery.payload.reply_markup ?? { inline_keyboard: [] },
      });
    });
  }

  async call(method: string, payload: object, signal?: AbortSignal): Promise<unknown> {
    if (
      (method === 'editMessageText' || method === 'editMessageReplyMarkup') &&
      'chat_id' in payload &&
      (typeof payload.chat_id === 'string' || typeof payload.chat_id === 'number') &&
      'message_id' in payload &&
      typeof payload.message_id === 'number'
    ) {
      return this.enqueueMessageUpdate(payload.chat_id, payload.message_id, () =>
        this.request(method, payload, signal),
      );
    }
    return this.request(method, payload, signal);
  }

  private enqueueMessageUpdate<T>(
    chatId: string | number,
    messageId: number,
    update: () => Promise<T>,
  ): Promise<T> {
    const key = `${chatId}:${messageId}`;
    const previous = this.messageUpdates.get(key) ?? Promise.resolve();
    const current = previous.then(update, update);
    this.messageUpdates.set(key, current);
    const release = () => {
      if (this.messageUpdates.get(key) === current) this.messageUpdates.delete(key);
    };
    void current.then(release, release);
    return current;
  }

  private async request(method: string, payload: object, signal?: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImplementation(
        `https://api.telegram.org/bot${this.config.TELEGRAM_BOT_TOKEN}/${method}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
            : AbortSignal.timeout(30_000),
        },
      );
    } catch (error) {
      throw new DeliveryUncertainError('Telegram delivery outcome is unknown', { cause: error });
    }

    if (response.status >= 500) {
      throw new DeliveryUncertainError('Telegram server outcome is unknown');
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch (error) {
      throw new DeliveryUncertainError('Telegram returned an invalid response', { cause: error });
    }

    const envelope = envelopeSchema.safeParse(raw);
    if (!envelope.success)
      throw new DeliveryUncertainError('Telegram returned an invalid response');
    if (envelope.data.ok) return envelope.data.result;

    if (
      (method === 'editMessageText' || method === 'editMessageReplyMarkup') &&
      envelope.data.error_code === 400 &&
      envelope.data.description?.includes('message is not modified')
    ) {
      return true;
    }

    throw new DeliveryRejectedError(
      `Telegram rejected request (${envelope.data.error_code ?? response.status})`,
    );
  }
}

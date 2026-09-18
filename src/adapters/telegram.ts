import { z } from 'zod';
import type { Config } from '../config.js';
import type { Draft, Page } from '../domain.js';
import { DeliveryRejectedError, DeliveryUncertainError } from '../errors.js';
import { renderTelegramMessage } from '../presentation.js';

const envelopeSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error_code: z.number().int().optional(),
  description: z.string().optional(),
});

const messageSchema = z.object({ message_id: z.number().int().positive() });

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class TelegramClient {
  constructor(
    private readonly config: Pick<Config, 'TELEGRAM_BOT_TOKEN' | 'TELEGRAM_CHAT_ID'>,
    private readonly fetchImplementation: FetchLike = fetch,
  ) {}

  async send(draft: Draft, page: Page): Promise<number> {
    const result = await this.call('sendMessage', {
      chat_id: this.config.TELEGRAM_CHAT_ID,
      ...renderTelegramMessage(draft, page.url),
    });
    const parsed = messageSchema.safeParse(result);
    if (!parsed.success) {
      throw new DeliveryUncertainError('Telegram accepted a message without returning its ID');
    }
    return parsed.data.message_id;
  }

  async edit(draft: Draft, page: Page, messageId: number): Promise<void> {
    await this.call('editMessageText', {
      chat_id: this.config.TELEGRAM_CHAT_ID,
      message_id: messageId,
      ...renderTelegramMessage(draft, page.url),
    });
  }

  private async call(method: string, payload: object): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImplementation(
        `https://api.telegram.org/bot${this.config.TELEGRAM_BOT_TOKEN}/${method}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(30_000),
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
      method === 'editMessageText' &&
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

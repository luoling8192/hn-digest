import { z } from 'zod';
import type { Config } from './config.js';
import { requestJson } from './http.js';
import { renderMessage, renderPage } from './render.js';
import type { Draft, Page } from './types.js';

const envelope = z.object({ ok: z.boolean(), result: z.unknown().optional(), error_code: z.number().optional(), description: z.string().optional() });
export class TelegramRejected extends Error {}
export class TelegramUncertain extends Error {}
export async function telegram(config: Config, method: string, payload: object): Promise<unknown> {
  let response: Response;
  try { response = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  }); } catch (error) {
    throw new TelegramUncertain('Telegram delivery outcome is unknown');
  }
  if (response.status >= 500) throw new TelegramUncertain('Telegram server outcome is unknown');
  let raw: unknown;
  try { raw = await response.json(); } catch { throw new TelegramUncertain('Invalid Telegram response'); }
  const parsed = envelope.safeParse(raw);
  if (!parsed.success) throw new TelegramUncertain('Invalid Telegram response');
  if (!parsed.data.ok) {
    if (method === 'editMessageText' && parsed.data.error_code === 400 && parsed.data.description?.includes('message is not modified')) return true;
    throw new TelegramRejected(`Telegram rejected request (${parsed.data.error_code ?? response.status})`);
  }
  return parsed.data.result;
}
export async function savePage(config: Config, draft: Draft, existing: Page | null): Promise<Page> {
  const payload = { access_token: config.TELEGRAPH_ACCESS_TOKEN, title: draft.summary.title,
    author_name: config.CHANNEL_NAME, author_url: config.CHANNEL_URL,
    content: renderPage(draft), ...(existing ? { path: existing.path } : {}) };
  const raw = await requestJson(`https://api.telegra.ph/${existing ? 'editPage' : 'createPage'}`, 'telegraph', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const parsed = z.object({ ok: z.boolean(), result: z.object({ path: z.string(), url: z.url() }).optional() }).parse(raw);
  if (!parsed.ok || !parsed.result) throw new Error('Telegraph rejected page');
  return parsed.result;
}
export async function sendMessage(config: Config, draft: Draft, page: Page): Promise<number> {
  const raw = await telegram(config, 'sendMessage', { chat_id: config.TELEGRAM_CHAT_ID, ...renderMessage(draft, page.url) });
  const result = z.object({ message_id: z.number().int() }).safeParse(raw);
  if (!result.success) throw new TelegramUncertain('Telegram message ID missing');
  return result.data.message_id;
}
export async function editMessage(config: Config, draft: Draft, page: Page, messageId: number): Promise<void> {
  await telegram(config, 'editMessageText', { chat_id: config.TELEGRAM_CHAT_ID, message_id: messageId, ...renderMessage(draft, page.url) });
}

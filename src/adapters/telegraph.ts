import { z } from 'zod';
import type { Config } from '../config.js';
import type { Draft, Page } from '../domain.js';
import type { JsonHttpClient } from '../http-client.js';
import { renderTelegraphPage } from '../presentation.js';

const responseSchema = z.object({
  ok: z.boolean(),
  result: z.object({ path: z.string().min(1), url: z.url() }).optional(),
  error: z.string().optional(),
});

export class TelegraphClient {
  constructor(
    private readonly config: Pick<
      Config,
      'TELEGRAPH_ACCESS_TOKEN' | 'CHANNEL_NAME' | 'CHANNEL_URL'
    >,
    private readonly http: JsonHttpClient,
  ) {}

  async save(draft: Draft, existing: Page | null): Promise<Page> {
    const operation = existing ? 'editPage' : 'createPage';
    const raw = await this.http.request(`https://api.telegra.ph/${operation}`, 'telegraph', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        access_token: this.config.TELEGRAPH_ACCESS_TOKEN,
        title: draft.summary.title,
        author_name: this.config.CHANNEL_NAME,
        author_url: this.config.CHANNEL_URL,
        content: renderTelegraphPage(draft),
        ...(existing ? { path: existing.path } : {}),
      }),
    });

    const response = responseSchema.parse(raw);
    if (!response.ok || !response.result) {
      throw new Error(`Telegraph rejected page: ${response.error ?? 'unknown error'}`);
    }
    return response.result;
  }
}

import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { z } from 'zod';
import type { Comment, HackerNewsItem } from '../domain.js';
import { hackerNewsItemSchema } from '../domain.js';
import type { JsonHttpClient } from '../http-client.js';

const HN_API = 'https://hacker-news.firebaseio.com/v0';

export function hackerNewsUrl(id: number): string {
  return `https://news.ycombinator.com/item?id=${id}`;
}

export function htmlToPlainText(html: string): string {
  const dom = new JSDOM(`<body>${html}</body>`);
  for (const element of dom.window.document.querySelectorAll('p,br')) element.prepend('\n');
  const text = dom.window.document.body.textContent?.trim() ?? '';
  dom.window.close();
  return text;
}

export function hashComments(comments: Comment[]): string {
  return createHash('sha256').update(JSON.stringify(comments)).digest('hex');
}

export interface CommentCollectionOptions {
  limit?: number;
  maxCharacters?: number;
  maxCommentCharacters?: number;
}

export class HackerNewsClient {
  constructor(private readonly http: JsonHttpClient) {}

  async getItem(id: number): Promise<HackerNewsItem | null> {
    const raw = await this.http.request(`${HN_API}/item/${id}.json`, 'hacker_news');
    return hackerNewsItemSchema.nullable().parse(raw);
  }

  async getTopStories(limit = 30): Promise<HackerNewsItem[]> {
    const ids = z
      .array(z.number().int().positive())
      .parse(await this.http.request(`${HN_API}/topstories.json`, 'hacker_news'))
      .slice(0, limit);
    const stories: HackerNewsItem[] = [];

    for (let offset = 0; offset < ids.length; offset += 6) {
      const items = await Promise.all(ids.slice(offset, offset + 6).map((id) => this.getItem(id)));
      for (const item of items) {
        if (item?.type === 'story' && !item.dead && !item.deleted) stories.push(item);
      }
    }

    return stories;
  }

  async collectComments(
    story: HackerNewsItem,
    options: CommentCollectionOptions = {},
  ): Promise<Comment[]> {
    return collectComments(story, (id) => this.getItem(id), options);
  }
}

export async function collectComments(
  story: HackerNewsItem,
  fetchItem: (id: number) => Promise<HackerNewsItem | null>,
  options: CommentCollectionOptions = {},
): Promise<Comment[]> {
  const limit = options.limit ?? 160;
  const maxCharacters = options.maxCharacters ?? 48_000;
  const maxCommentCharacters = options.maxCommentCharacters ?? 2_500;
  const queue = [...story.kids];
  const seen = new Set<number>();
  const comments: Comment[] = [];
  let characters = 0;
  let scanned = 0;

  while (
    queue.length > 0 &&
    comments.length < limit &&
    characters < maxCharacters &&
    scanned < limit * 3
  ) {
    const batch = queue
      .splice(0, Math.min(8, limit - comments.length))
      .filter((id) => !seen.has(id));
    for (const id of batch) seen.add(id);
    scanned += batch.length;

    const items = await Promise.all(batch.map(fetchItem));
    for (const item of items) {
      if (!item) continue;
      queue.push(...item.kids);
      if (item.deleted || item.dead || !item.text || item.parent === undefined || !item.by)
        continue;

      const available = Math.min(maxCommentCharacters, maxCharacters - characters);
      const text = htmlToPlainText(item.text).slice(0, available);
      if (!text) continue;

      comments.push({ id: item.id, parent: item.parent, author: item.by, text });
      characters += text.length;
    }
  }

  return comments;
}

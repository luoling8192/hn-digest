import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { z } from 'zod';
import { requestJson } from './http.js';
import { itemSchema, type Item, type Comment } from './types.js';

export const hnUrl = (id: number) => `https://news.ycombinator.com/item?id=${id}`;
export function plainText(html: string): string {
  const dom = new JSDOM(`<body>${html}</body>`);
  for (const el of dom.window.document.querySelectorAll('p,br')) el.prepend('\n');
  const text = dom.window.document.body.textContent?.trim() ?? '';
  dom.window.close();
  return text;
}
export async function getItem(id: number): Promise<Item | null> {
  return itemSchema.nullable().parse(await requestJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, 'hn'));
}
export async function frontPage(): Promise<Item[]> {
  const ids = z.array(z.number().int()).parse(await requestJson('https://hacker-news.firebaseio.com/v0/topstories.json', 'hn')).slice(0, 30);
  const items: Item[] = [];
  for (let i = 0; i < ids.length; i += 6) {
    const batch = await Promise.all(ids.slice(i, i + 6).map(getItem));
    for (const item of batch) if (item && item.type === 'story' && !item.deleted && !item.dead) items.push(item);
  }
  return items;
}
export async function collectComments(story: Item, fetchItem = getItem, limit = 160, maxChars = 48_000): Promise<Comment[]> {
  const queue = [...story.kids];
  const seen = new Set<number>();
  const comments: Comment[] = [];
  let chars = 0;
  let scanned = 0;
  while (queue.length && comments.length < limit && chars < maxChars && scanned < limit * 3) {
    const ids = queue.splice(0, Math.min(8, limit - comments.length)).filter(id => !seen.has(id));
    ids.forEach(id => seen.add(id));
    scanned += ids.length;
    for (const item of await Promise.all(ids.map(fetchItem))) {
      if (!item) continue;
      queue.push(...item.kids);
      if (item.deleted || item.dead || !item.text || item.parent === undefined || !item.by) continue;
      const text = plainText(item.text).slice(0, Math.min(2500, maxChars - chars));
      if (!text) continue;
      comments.push({ id: item.id, parent: item.parent, author: item.by, text });
      chars += text.length;
    }
  }
  return comments;
}
export function commentsHash(comments: Comment[]) {
  return createHash('sha256').update(JSON.stringify(comments)).digest('hex');
}

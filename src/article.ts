import { lookup } from 'node:dns';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import ipaddr from 'ipaddr.js';
import { Agent, fetch } from 'undici';
import { plainText } from './hn.js';
import { log } from './http.js';
import type { Article, Item } from './types.js';

export function publicAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === 'unicast'; }
  catch { return false; }
}
export function safeUrl(raw: string): URL {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsafe article URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(host) && !publicAddress(host)) throw new Error('Private article address');
  return url;
}
const dispatcher = new Agent({ connect: { lookup(hostname, options, callback) {
  lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, [], undefined);
    if (!addresses.length || addresses.some(a => !publicAddress(a.address))) return callback(new Error('Private article address'), [], undefined);
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  });
} } });

export async function fetchArticle(story: Item): Promise<Article> {
  if (!story.url) {
    const text = plainText(story.text ?? '');
    return { text, source: text ? 'hn-text' : 'unavailable', readingMinutes: text ? readingTime(text) : null };
  }
  try {
    let url = safeUrl(story.url);
    for (let redirect = 0; redirect <= 5; redirect++) {
      const response = await fetch(url, { dispatcher, redirect: 'manual', signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'HNDigest/1.0 (article summarizer)', accept: 'text/html,text/plain' } });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) throw new Error('Missing redirect');
        url = safeUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error('Article unavailable'); }
      const kind = response.headers.get('content-type') ?? '';
      if (!/text\/html|text\/plain|application\/xhtml/.test(kind)) { await response.body?.cancel(); throw new Error('Unsupported article type'); }
      const reader = response.body!.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 3_000_000) { await reader.cancel(); throw new Error('Article too large'); }
        chunks.push(value);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      let text: string;
      if (kind.includes('text/plain')) text = raw.trim();
      else {
        const dom = new JSDOM(raw, { url: url.href });
        text = new Readability(dom.window.document).parse()?.textContent?.trim() ?? '';
        dom.window.close();
      }
      if (text.length < 200) throw new Error('Insufficient article text');
      return { text: text.slice(0, 45_000), source: 'article', readingMinutes: readingTime(text) };
    }
    throw new Error('Too many redirects');
  } catch {
    log('article_unavailable', { storyId: story.id });
    return { text: '', source: 'unavailable', readingMinutes: null };
  }
}
export function readingTime(text: string): number {
  const cjk = (text.match(/[\p{Script=Han}]/gu) ?? []).length;
  const words = text.replace(/[\p{Script=Han}]/gu, '').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(cjk / 400 + words / 220));
}

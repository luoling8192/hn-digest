import { lookup } from 'node:dns';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as undiciFetch } from 'undici';
import type { Article, HackerNewsItem } from '../domain.js';
import { errorCode } from '../errors.js';
import type { Logger } from '../logger.js';
import { htmlToPlainText } from './hacker-news.js';

const MAX_REDIRECTS = 5;
const MAX_DOWNLOAD_BYTES = 3_000_000;
const MAX_SUMMARY_CHARACTERS = 45_000;

export function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}

export function parsePublicHttpUrl(raw: string): URL {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Unsafe article URL');
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(host) && !isPublicAddress(host)) throw new Error('Private article address');
  return url;
}

export function estimateReadingMinutes(text: string): number {
  const hanCharacters = (text.match(/[\p{Script=Han}]/gu) ?? []).length;
  const words = text
    .replace(/[\p{Script=Han}]/gu, '')
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.ceil(hanCharacters / 400 + words / 220));
}

const publicNetworkDispatcher = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      lookup(hostname, { ...options, all: true }, (error, addresses) => {
        if (error) {
          callback(error, [], undefined);
          return;
        }
        const first = addresses[0];
        if (!first || addresses.some((address) => !isPublicAddress(address.address))) {
          callback(new Error('Private article address'), [], undefined);
          return;
        }
        if (options.all) callback(null, addresses);
        else callback(null, first.address, first.family);
      });
    },
  },
});

export class ArticleExtractor {
  constructor(private readonly logger: Logger) {}

  async extract(story: HackerNewsItem): Promise<Article> {
    if (!story.url) {
      const text = htmlToPlainText(story.text ?? '');
      return {
        text,
        source: text ? 'hn-text' : 'unavailable',
        readingMinutes: text ? estimateReadingMinutes(text) : null,
      };
    }

    try {
      return await this.extractRemote(story.url);
    } catch (error) {
      this.logger.warn('article_unavailable', { storyId: story.id, code: errorCode(error) });
      return { text: '', source: 'unavailable', readingMinutes: null };
    }
  }

  private async extractRemote(rawUrl: string): Promise<Article> {
    let url = parsePublicHttpUrl(rawUrl);

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const response = await undiciFetch(url, {
        dispatcher: publicNetworkDispatcher,
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
        headers: {
          'user-agent': 'HNDigest/2.0 (article summarizer)',
          accept: 'text/html,text/plain',
        },
      });

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) throw new Error('Article redirect omitted its location');
        url = parsePublicHttpUrl(new URL(location, url).href);
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Article returned HTTP ${response.status}`);
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!/text\/html|text\/plain|application\/xhtml/.test(contentType)) {
        await response.body?.cancel();
        throw new Error('Unsupported article type');
      }

      const raw = await readLimitedBody(response, MAX_DOWNLOAD_BYTES);
      const text = contentType.includes('text/plain') ? raw.trim() : readableText(raw, url);
      if (text.length < 200) throw new Error('Insufficient article text');

      return {
        text: text.slice(0, MAX_SUMMARY_CHARACTERS),
        source: 'article',
        readingMinutes: estimateReadingMinutes(text),
      };
    }

    throw new Error('Too many article redirects');
  }
}

async function readLimitedBody(
  response: Awaited<ReturnType<typeof undiciFetch>>,
  limit: number,
): Promise<string> {
  if (!response.body) throw new Error('Article response omitted its body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error('Article too large');
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks).toString('utf8');
}

function readableText(html: string, url: URL): string {
  const dom = new JSDOM(html, { url: url.href });
  const text = new Readability(dom.window.document).parse()?.textContent?.trim() ?? '';
  dom.window.close();
  return text;
}

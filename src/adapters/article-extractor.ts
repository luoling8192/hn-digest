import { createHash } from 'node:crypto';
import { lookup } from 'node:dns';
import ipaddr from 'ipaddr.js';
import { JSDOM } from 'jsdom';
import { Agent, fetch as undiciFetch } from 'undici';
import { z } from 'zod';
import type { Article, HackerNewsItem } from '../domain.js';
import { ApplicationError, errorCode, RemoteHttpError } from '../errors.js';
import type { Logger } from '../logger.js';
import {
  looksLikeChallengePage,
  withoutMediumResponses,
  withoutReutersFooter,
} from './article-quality.js';
import { htmlToPlainText } from './hacker-news.js';

const MAX_DOWNLOAD_BYTES = 3_000_000;
const MAX_SUMMARY_CHARACTERS = 45_000;
const MIN_ARTICLE_CHARACTERS = 200;
const FIRECRAWL_URL = 'https://api.firecrawl.dev/v2/scrape';
const MAX_ARTICLE_IMAGES = 8;

interface ScrapedArticle {
  text: string;
  media: NonNullable<Article['media']>;
}

type Fetcher = (
  input: string | URL,
  init?: Parameters<typeof undiciFetch>[1],
) => ReturnType<typeof undiciFetch>;

interface ExtractionRuntime {
  now(): number;
}

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
  private retryAt = 0;

  constructor(
    private readonly logger: Logger,
    private readonly apiKey: string,
    private readonly fetcher: Fetcher = undiciFetch,
    private readonly runtime: ExtractionRuntime = { now: Date.now },
  ) {}

  async extract(story: HackerNewsItem): Promise<Article> {
    if (!story.url) {
      const text = htmlToPlainText(story.text ?? '');
      return {
        text,
        source: text ? 'hn-text' : 'unavailable',
        readingMinutes: text ? estimateReadingMinutes(text) : null,
      };
    }

    let url: URL;
    try {
      url = parsePublicHttpUrl(story.url);
      url.hash = '';
    } catch {
      this.logger.warn('article_unavailable', { storyId: story.id, code: 'unsafe_article_url' });
      return {
        text: '',
        source: 'unavailable',
        readingMinutes: null,
        failureCode: 'unsafe_article_url',
      };
    }
    const startedAt = Date.now();
    const fields = { storyId: story.id, host: url.hostname, method: 'firecrawl' };
    this.logger.info('article_fetch_started', fields);
    try {
      const { text, media } = await this.scrape(url, story.id);
      const article = articleFromText(text, media);
      this.logger.info('article_fetch_succeeded', {
        ...fields,
        durationMs: Date.now() - startedAt,
        characters: article.text.length,
        sourceCharacters: text.length,
        truncated: text.length > MAX_SUMMARY_CHARACTERS,
      });
      return article;
    } catch (error) {
      const failureCode = articleErrorCode(error);
      this.logger.warn('article_fetch_failed', {
        ...fields,
        durationMs: Date.now() - startedAt,
        code: failureCode,
        status: error instanceof RemoteHttpError ? error.status : undefined,
        retryAfterSeconds: error instanceof RemoteHttpError ? error.retryAfterSeconds : undefined,
      });
      this.logger.warn('article_unavailable', { storyId: story.id, code: failureCode });
      return { text: '', source: 'unavailable', readingMinutes: null, failureCode };
    }
  }

  private async scrape(url: URL, storyId: number): Promise<ScrapedArticle> {
    if (this.retryAt > this.runtime.now()) {
      throw new RemoteHttpError(
        'firecrawl',
        429,
        Math.ceil((this.retryAt - this.runtime.now()) / 1000),
      );
    }
    const response = await this.fetcher(FIRECRAWL_URL, {
      dispatcher: publicNetworkDispatcher,
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(75_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        url: url.href,
        formats: ['markdown', 'html'],
        onlyMainContent: true,
        proxy: 'auto',
        waitFor: 1_500,
        maxAge: 0,
        timeout: 60_000,
      }),
    });
    this.logger.info('article_fetch_response', {
      storyId,
      method: 'firecrawl',
      status: response.status,
      contentType: response.headers.get('content-type'),
    });
    if (!response.ok) {
      const retryAfter = retryAfterSeconds(response, this.runtime.now());
      await response.body?.cancel();
      if (response.status === 429)
        this.retryAt = Math.max(this.retryAt, this.runtime.now() + (retryAfter ?? 60) * 1000);
      throw new RemoteHttpError('firecrawl', response.status, retryAfter);
    }
    const raw = await readLimitedBody(response, MAX_DOWNLOAD_BYTES);
    const result = z
      .object({
        success: z.literal(true),
        data: z.object({
          markdown: z.string(),
          html: z.string().optional(),
          metadata: z.object({
            statusCode: z.number().int(),
            title: z.string().optional(),
            ogImage: z.unknown().optional(),
            sourceURL: z.unknown().optional(),
          }),
        }),
      })
      .parse(JSON.parse(raw.toString('utf8')));
    const status = result.data.metadata.statusCode;
    if ((status < 200 || status >= 300) && status !== 304)
      throw new RemoteHttpError('article', status);
    validateArticleText(result.data.markdown, result.data.metadata.title);
    const text = withoutReutersFooter(withoutMediumResponses(result.data.markdown), url);
    validateArticleText(text, result.data.metadata.title);
    const baseUrl = publicImageUrl(result.data.metadata.sourceURL, url) ?? url.href;
    return {
      text,
      media: extractMedia(result.data.html ?? '', new URL(baseUrl), result.data.metadata.ogImage),
    };
  }
}

function retryAfterSeconds(
  response: Awaited<ReturnType<typeof undiciFetch>>,
  now: number,
): number | undefined {
  const value = response.headers.get('retry-after');
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - now) / 1000)) : undefined;
}

function articleFromText(text: string, media: NonNullable<Article['media']>): Article {
  return {
    text: text.slice(0, MAX_SUMMARY_CHARACTERS),
    source: 'article',
    readingMinutes: estimateReadingMinutes(text),
    media,
  };
}

function publicImageUrl(raw: unknown, baseUrl: URL): string | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 4_096) return null;
  try {
    const url = parsePublicHttpUrl(new URL(raw, baseUrl).href);
    if (url.href.length > 4_096) return null;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function extractMedia(html: string, baseUrl: URL, ogImage: unknown): NonNullable<Article['media']> {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const images: NonNullable<Article['media']>['images'] = [];
  const seen = new Set<string>();
  const metadataCover = publicImageUrl(ogImage, baseUrl);
  const htmlCover = publicImageUrl(
    document.querySelector('meta[property="og:image"]')?.getAttribute('content'),
    baseUrl,
  );

  for (const image of document.querySelectorAll('img')) {
    if (images.length >= MAX_ARTICLE_IMAGES) break;
    if (image.closest('nav,header,footer,aside,[aria-hidden="true"]')) continue;
    const dimensions = [image.getAttribute('width'), image.getAttribute('height')]
      .filter((value) => value !== null)
      .map((value) => Number.parseFloat(value));
    if (dimensions.some((value) => Number.isFinite(value) && value < 64)) continue;
    const url =
      publicImageUrl(image.getAttribute('src'), baseUrl) ??
      publicImageUrl(image.getAttribute('data-src'), baseUrl);
    if (!url || seen.has(url)) continue;
    const identity = `${new URL(url).pathname} ${image.id} ${image.className}`;
    if (
      /(?:^|[\s/_.-])(?:favicon|icon|logo|avatar|pixel|tracking|beacon)(?:[\s/_.-]|$)/i.test(
        identity,
      )
    )
      continue;
    const caption = (
      image.closest('figure')?.querySelector('figcaption')?.textContent ||
      image.getAttribute('alt') ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1_000);
    seen.add(url);
    images.push({
      id: `image-${createHash('sha256').update(url).digest('hex').slice(0, 12)}`,
      url,
      caption,
    });
  }
  dom.window.close();
  return { coverImage: metadataCover ?? htmlCover ?? images[0]?.url ?? null, images };
}

async function readLimitedBody(
  response: Awaited<ReturnType<typeof undiciFetch>>,
  limit: number,
): Promise<Buffer> {
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
      throw new ApplicationError('article_too_large', 502, 'Article too large');
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks);
}

function validateArticleText(text: string, title = ''): void {
  if (looksLikeChallengePage(text, title)) {
    throw new ApplicationError(
      'article_challenge_page',
      502,
      'Article response is an access challenge',
    );
  }
  if (text.trim().length < MIN_ARTICLE_CHARACTERS) {
    throw new ApplicationError('article_text_insufficient', 502, 'Insufficient article text');
  }
}

function articleErrorCode(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'article_timeout';
    if (
      error.cause instanceof Error &&
      'code' in error.cause &&
      typeof error.cause.code === 'string'
    ) {
      if (/^(?:E[A-Z]+|UND_ERR_[A-Z_]+)$/.test(error.cause.code)) return error.cause.code;
    }
  }
  return errorCode(error);
}

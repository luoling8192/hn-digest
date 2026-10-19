import { lookup } from 'node:dns';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as undiciFetch } from 'undici';
import { z } from 'zod';
import type { Article, HackerNewsItem } from '../domain.js';
import { ApplicationError, errorCode, RemoteHttpError } from '../errors.js';
import type { Logger } from '../logger.js';
import { htmlToPlainText } from './hacker-news.js';
import {
  looksLikeChallengePage,
  withoutMediumResponses,
  withoutReutersFooter,
} from './article-quality.js';

const MAX_DOWNLOAD_BYTES = 3_000_000;
const MAX_SUMMARY_CHARACTERS = 45_000;
const MIN_ARTICLE_CHARACTERS = 200;
const FIRECRAWL_URL = 'https://api.firecrawl.dev/v2/scrape';

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
      const text = await this.scrape(url, story.id);
      const article = articleFromText(text);
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

  private async scrape(url: URL, storyId: number): Promise<string> {
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
        formats: ['markdown'],
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
          metadata: z.object({ statusCode: z.number().int(), title: z.string().optional() }),
        }),
      })
      .parse(JSON.parse(raw.toString('utf8')));
    const status = result.data.metadata.statusCode;
    if ((status < 200 || status >= 300) && status !== 304)
      throw new RemoteHttpError('article', status);
    validateArticleText(result.data.markdown, result.data.metadata.title);
    const text = withoutReutersFooter(withoutMediumResponses(result.data.markdown), url);
    validateArticleText(text, result.data.metadata.title);
    return text;
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

function articleFromText(text: string): Article {
  return {
    text: text.slice(0, MAX_SUMMARY_CHARACTERS),
    source: 'article',
    readingMinutes: estimateReadingMinutes(text),
  };
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

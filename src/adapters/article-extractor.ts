import { lookup } from 'node:dns';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as undiciFetch } from 'undici';
import { z } from 'zod';
import type { Article, HackerNewsItem } from '../domain.js';
import { ApplicationError, errorCode, RemoteHttpError } from '../errors.js';
import type { Logger } from '../logger.js';
import { htmlToPlainText } from './hacker-news.js';

const MAX_REDIRECTS = 5;
const MAX_DOWNLOAD_BYTES = 3_000_000;
const MAX_SUMMARY_CHARACTERS = 45_000;
const MIN_ARTICLE_CHARACTERS = 200;
const READER_BASE_URL = 'https://r.jina.ai/';

type Fetcher = (
  input: string | URL,
  init?: Parameters<typeof undiciFetch>[1],
) => ReturnType<typeof undiciFetch>;

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
  constructor(
    private readonly logger: Logger,
    private readonly fetcher: Fetcher = undiciFetch,
    private readonly jinaApiKey?: string,
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
    } catch {
      this.logger.warn('article_unavailable', { storyId: story.id, code: 'unsafe_article_url' });
      return { text: '', source: 'unavailable', readingMinutes: null };
    }
    for (const method of ['jina', 'direct'] as const) {
      const startedAt = Date.now();
      const fields = { storyId: story.id, host: url.hostname, method };
      this.logger.info('article_fetch_started', fields);
      try {
        const article =
          method === 'jina'
            ? articleFromText(await this.extractRendered(url, story.id))
            : await this.extractRemote(url.href, story.id);
        this.logger.info('article_fetch_succeeded', {
          ...fields,
          durationMs: Date.now() - startedAt,
          characters: article.text.length,
        });
        return article;
      } catch (error) {
        this.logger.warn('article_fetch_failed', {
          ...fields,
          durationMs: Date.now() - startedAt,
          code: articleErrorCode(error),
          status: error instanceof RemoteHttpError ? error.status : undefined,
        });
      }
    }
    this.logger.warn('article_unavailable', {
      storyId: story.id,
      code: 'all_fetch_methods_failed',
    });
    return { text: '', source: 'unavailable', readingMinutes: null };
  }

  private async extractRemote(rawUrl: string, storyId: number): Promise<Article> {
    let url = parsePublicHttpUrl(rawUrl);

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const response = await this.fetcher(url, {
        dispatcher: publicNetworkDispatcher,
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
        headers: {
          'user-agent': 'HNDigest/2.0 (article summarizer)',
          accept: 'text/html,text/plain',
        },
      });
      this.logger.info('article_fetch_response', {
        storyId,
        method: 'direct',
        status: response.status,
        contentType: response.headers.get('content-type'),
      });

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location)
          throw new ApplicationError('article_redirect_missing', 502, 'Missing redirect');
        url = parsePublicHttpUrl(new URL(location, url).href);
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel();
        throw new RemoteHttpError('article', response.status);
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!/text\/html|text\/plain|application\/xhtml/.test(contentType)) {
        await response.body?.cancel();
        throw new ApplicationError('article_type_unsupported', 502, 'Unsupported article type');
      }

      const raw = await readLimitedBody(response, MAX_DOWNLOAD_BYTES);
      const text = contentType.includes('text/plain') ? raw.trim() : readableText(raw, url);
      validateArticleText(text);
      return articleFromText(text);
    }

    throw new ApplicationError('article_redirect_limit', 502, 'Too many article redirects');
  }

  private async extractRendered(url: URL, storyId: number): Promise<string> {
    const target = new URL(url);
    target.hash = '';
    const readerUrl = new URL(`${READER_BASE_URL}${target.href}`);
    const response = await this.fetcher(readerUrl, {
      dispatcher: publicNetworkDispatcher,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        'user-agent': 'HNDigest/2.0 (article summarizer)',
        accept: 'application/json',
        ...(this.jinaApiKey ? { authorization: `Bearer ${this.jinaApiKey}` } : {}),
        'x-timeout': '20',
      },
    });
    this.logger.info('article_fetch_response', {
      storyId,
      method: 'jina',
      status: response.status,
      contentType: response.headers.get('content-type'),
    });

    if (!response.ok) {
      await response.body?.cancel();
      throw new RemoteHttpError('jina', response.status);
    }

    const raw = await readLimitedBody(response, MAX_DOWNLOAD_BYTES);
    const result = z
      .object({ data: z.object({ content: z.string(), title: z.string().optional() }) })
      .parse(JSON.parse(raw));
    validateArticleText(result.data.content, result.data.title);
    return result.data.content;
  }
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
      throw new ApplicationError('article_too_large', 502, 'Article too large');
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

function validateArticleText(text: string, title = ''): void {
  if (
    /^(just a moment|access denied|attention required|verify you are human|security checkpoint)/i.test(
      title.trim(),
    ) ||
    /^(?:#\s*)?(?:just a moment|verify you are human|checking your browser|enable javascript and cookies to continue|access denied)/i.test(
      text.trim(),
    )
  ) {
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

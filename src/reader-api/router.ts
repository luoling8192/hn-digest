import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { Logger } from '../logger.js';
import type { ReadingStore } from '../recommendations/store.js';
import { errorCode } from '../errors.js';
import {
  type ArticleIndex,
  decodeCursor,
  detailOf,
  encodeCursor,
  page,
  publishedAtMs,
  summaryOf,
} from './articles.js';
import { listBookmarks, setBookmark } from './bookmarks.js';
import { codePattern, type LinkStore, secretPattern } from './links.js';
import { IpRateLimiter } from './rate-limit.js';

export interface ReaderApiOptions {
  articles: ArticleIndex;
  store: ReadingStore | null;
  links: LinkStore | null;
  /** Telegram bot username without '@'; link endpoints are disabled without it. */
  botUsername: string | undefined;
  logger: Logger;
  now?: () => number;
}

const defaultLimit = 20;
const maxLimit = 50;
const maxBody = 4_096;

const startBody = z.object({ secret: z.string().regex(secretPattern) }).strict();
const pollBody = z.object({ code: z.string(), secret: z.string() }).strict();

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export class ReaderApi {
  private readonly general = new IpRateLimiter({ burst: 60, refillPerMinute: 120 });
  private readonly linkStart = new IpRateLimiter({ burst: 5, refillPerMinute: 6 });
  private readonly now: () => number;

  constructor(private readonly options: ReaderApiOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Returns false when the path is not an /api/v1 route. */
  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith('/api/v1/')) return false;
    try {
      const client = clientAddress(request);
      const admission = this.general.admit(client);
      if (!admission.allowed) throw rateLimited(admission.retryAfterSeconds);
      await this.route(request, response, url, client);
    } catch (error) {
      if (error instanceof ApiError) {
        respond(response, error.status, { error: error.code }, 'no-store', retryHeader(error));
      } else {
        this.options.logger.error('reader_api_failed', { code: errorCode(error) });
        respond(response, 500, { error: 'internal_error' }, 'no-store');
      }
    }
    return true;
  }

  private async route(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    client: string,
  ): Promise<void> {
    const path = url.pathname.slice('/api/v1'.length);
    const method = request.method ?? 'GET';
    if (path === '/articles' && method === 'GET') {
      const { cursor, limit } = pagination(url);
      const { items, nextCursor } = page(
        this.options.articles.list(),
        (p) => ({ time: publishedAtMs(p), id: p.id }),
        cursor,
        limit,
      );
      respond(response, 200, { items: items.map(summaryOf), nextCursor }, 'public, max-age=30');
      return;
    }
    const article = path.match(/^\/articles\/([^/]+)$/);
    if (article && method === 'GET') {
      const publication = this.options.articles.get(articleId(article[1]));
      if (!publication) throw new ApiError(404, 'article_not_found');
      respond(response, 200, detailOf(publication), 'public, max-age=60');
      return;
    }
    if (path === '/link/start' && method === 'POST') {
      const links = this.linkSupport();
      const admission = this.linkStart.admit(client);
      if (!admission.allowed) throw rateLimited(admission.retryAfterSeconds);
      const body = startBody.safeParse(await readJson(request));
      if (!body.success) throw new ApiError(400, 'invalid_request');
      const { code, expiresAt } = links.links.start(body.data.secret);
      respond(
        response,
        200,
        {
          code,
          botUrl: `https://t.me/${links.bot}?start=link_${code}`,
          expiresAt: new Date(expiresAt).toISOString(),
        },
        'no-store',
      );
      return;
    }
    if (path === '/link/poll' && method === 'POST') {
      const links = this.linkSupport();
      const body = pollBody.safeParse(await readJson(request));
      if (!body.success) throw new ApiError(400, 'invalid_request');
      if (!codePattern.test(body.data.code) || !secretPattern.test(body.data.secret)) {
        throw new ApiError(400, 'invalid_request');
      }
      const result = links.links.poll(body.data.code, body.data.secret);
      if (result.status === 'expired') throw new ApiError(410, 'link_expired');
      respond(
        response,
        200,
        result.status === 'linked'
          ? { status: 'linked', token: result.token }
          : { status: 'pending' },
        'no-store',
      );
      return;
    }
    if (path === '/link/revoke' && method === 'POST') {
      const links = this.linkSupport();
      const token = bearer(request);
      if (!token || !links.links.revoke(token)) throw new ApiError(401, 'unauthorized');
      respond(response, 200, { revoked: true }, 'no-store');
      return;
    }
    if (path === '/bookmarks' && method === 'GET') {
      const { store, userId } = this.authenticate(request);
      const { cursor, limit } = pagination(url);
      const entries = listBookmarks(store, userId).flatMap((bookmark) => {
        const publication = this.options.articles.get(bookmark.articleId);
        return publication ? [{ bookmark, publication }] : [];
      });
      const result = page(
        entries,
        (entry) => ({ time: entry.bookmark.savedAt, id: entry.bookmark.articleId }),
        cursor,
        limit,
      );
      respond(
        response,
        200,
        {
          items: result.items.map((entry) => ({
            ...summaryOf(entry.publication),
            savedAt: new Date(entry.bookmark.savedAt).toISOString(),
          })),
          nextCursor: result.nextCursor,
        },
        'no-store',
      );
      return;
    }
    const bookmark = path.match(/^\/bookmarks\/([^/]+)$/);
    if (bookmark && (method === 'PUT' || method === 'DELETE')) {
      const { store, userId } = this.authenticate(request);
      const id = articleId(bookmark[1]);
      const publication = this.options.articles.get(id);
      if (method === 'PUT') {
        if (!publication) throw new ApiError(404, 'article_not_found');
        setBookmark(store, userId, publication, true, this.now());
      } else {
        // Allow removing a save even after the article stopped being readable.
        const stored = publication ?? null;
        if (stored) setBookmark(store, userId, stored, false, this.now());
        else removeUnreadable(store, userId, id);
      }
      respond(response, 200, { articleId: id, saved: method === 'PUT' }, 'no-store');
      return;
    }
    throw new ApiError(path.startsWith('/bookmarks') ? 405 : 404, 'not_found');
  }

  private linkSupport(): { links: LinkStore; bot: string } {
    if (!this.options.links || !this.options.botUsername)
      throw new ApiError(503, 'link_unavailable');
    return { links: this.options.links, bot: this.options.botUsername };
  }

  private authenticate(request: IncomingMessage): { store: ReadingStore; userId: number } {
    const token = bearer(request);
    const userId = token && this.options.links ? this.options.links.authenticate(token) : null;
    if (userId === null || !this.options.store) throw new ApiError(401, 'unauthorized');
    return { store: this.options.store, userId };
  }
}

function removeUnreadable(store: ReadingStore, userId: number, id: number): void {
  store.transaction(() => {
    const reader = store.reader(userId);
    const current = reader?.feedback[id];
    if (!reader || !current?.saved) return;
    reader.feedback[id] = { ...current, saved: false, revision: current.revision + 1 };
    store.saveReader(reader);
  });
}

function articleId(raw: string | undefined): number {
  if (!raw || !/^[1-9]\d{0,15}$/.test(raw)) throw new ApiError(400, 'invalid_article_id');
  return Number(raw);
}

function pagination(url: URL): {
  cursor: { time: number; id: number } | null;
  limit: number;
} {
  const rawLimit = url.searchParams.get('limit');
  let limit = defaultLimit;
  if (rawLimit !== null) {
    if (!/^[1-9]\d{0,3}$/.test(rawLimit)) throw new ApiError(400, 'invalid_limit');
    limit = Math.min(maxLimit, Number(rawLimit));
  }
  const rawCursor = url.searchParams.get('cursor');
  if (!rawCursor) return { cursor: null, limit };
  const cursor = decodeCursor(rawCursor);
  if (!cursor) throw new ApiError(400, 'invalid_cursor');
  return { cursor, limit };
}

function bearer(request: IncomingMessage): string | null {
  const match = (request.headers.authorization ?? '').match(/^Bearer (\S+)$/);
  return match?.[1] ?? null;
}

// Railway terminates TLS in a proxy that appends the real client to X-Forwarded-For.
function clientAddress(request: IncomingMessage): string {
  const forwarded = request.headers['x-forwarded-for'];
  const last = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded)
    ?.split(',')
    .at(-1)
    ?.trim();
  return last || request.socket.remoteAddress || 'unknown';
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json\b/i.test(request.headers['content-type'] ?? '')) {
    throw new ApiError(415, 'unsupported_media_type');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > maxBody) throw new ApiError(413, 'payload_too_large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'invalid_json');
  }
}

function rateLimited(retryAfterSeconds: number): ApiError & { retryAfterSeconds: number } {
  return Object.assign(new ApiError(429, 'rate_limited'), { retryAfterSeconds });
}

function retryHeader(error: ApiError): Record<string, string> {
  const seconds = (error as { retryAfterSeconds?: number }).retryAfterSeconds;
  return seconds ? { 'retry-after': String(seconds) } : {};
}

function respond(
  response: ServerResponse,
  status: number,
  body: unknown,
  cacheControl: string,
  extra: Record<string, string> = {},
): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': cacheControl,
    'x-content-type-options': 'nosniff',
    ...extra,
  });
  response.end(JSON.stringify(body));
}

export { encodeCursor };

import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DigestService } from './application/digest-service.js';
import { errorCode, errorStatus } from './errors.js';
import type { Logger } from './logger.js';
import { renderTelegramMessage, renderTelegraphPage } from './presentation.js';

interface AdminServerOptions {
  adminToken: string;
  service: DigestService;
  logger: Logger;
  startedAt?: string;
  stopping?: () => boolean;
}

export function createAdminServer(options: AdminServerOptions): Server {
  const startedAt = options.startedAt ?? new Date().toISOString();

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') {
      const stopping = options.stopping?.() ?? false;
      respondJson(response, stopping ? 503 : 200, { status: stopping ? 'stopping' : 'ok' });
      return;
    }

    if (!authorized(request, options.adminToken)) {
      respondJson(response, 401, { error: 'Unauthorized' });
      return;
    }

    try {
      await routeAdminRequest(request, response, url, options.service, startedAt, options.logger);
    } catch (error) {
      const code = errorCode(error);
      options.logger.error('admin_failed', { code });
      respondJson(response, errorStatus(error), { error: code });
    }
  });
}

async function routeAdminRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  service: DigestService,
  startedAt: string,
  logger: Logger,
): Promise<void> {
  if (url.pathname === '/admin/status' && request.method === 'GET') {
    respondJson(response, 200, {
      startedAt,
      autoPublish: service.automaticPublishingEnabled(),
      busy: service.isRunning,
      lastCycle: service.lastCycle(),
      publications: service.publications().map((publication) => ({
        id: publication.id,
        state: publication.state,
        title: publication.draft.summary.title,
        page: publication.page,
        messageId: publication.messageId,
        commentsSampled: publication.draft.comments.length,
        commentCount: publication.draft.commentCount,
        updates: publication.updates,
      })),
      failures: service.failures().map((failure) => ({
        id: failure.id,
        attempts: failure.attempts,
        next_retry: failure.nextRetry,
        code: failure.code,
      })),
    });
    return;
  }

  if (request.method !== 'POST') {
    respondJson(response, 404, { error: 'Not found' });
    return;
  }

  if (url.pathname === '/admin/enable') {
    service.setAutomaticPublishing(true);
    respondJson(response, 200, { autoPublish: true });
    return;
  }
  if (url.pathname === '/admin/pause') {
    service.setAutomaticPublishing(false);
    respondJson(response, 200, { autoPublish: false });
    return;
  }
  if (url.pathname === '/admin/run') {
    if (service.isRunning) {
      respondJson(response, 409, { error: 'worker_busy' });
      return;
    }
    void service.runCycle().catch((error) => {
      logger.error('cycle_failed', { code: errorCode(error) });
    });
    respondJson(response, 202, { accepted: true });
    return;
  }

  const match = url.pathname.match(/^\/admin\/(preview|publish)\/(\d+)$/);
  if (!match) {
    respondJson(response, 404, { error: 'Not found' });
    return;
  }

  const id = Number(match[2]);
  if (!Number.isSafeInteger(id) || id <= 0) {
    respondJson(response, 400, { error: 'invalid_story_id' });
    return;
  }

  if (match[1] === 'preview') {
    const draft = await service.preview(id, url.searchParams.get('regenerate') === 'true');
    respondJson(response, 200, {
      draft,
      content: renderTelegraphPage(draft),
      message: renderTelegramMessage(draft, 'https://telegra.ph/preview'),
    });
    return;
  }

  const publication = await service.publish(id);
  respondJson(response, 200, {
    id,
    state: publication.state,
    page: publication.page,
    messageId: publication.messageId,
  });
}

function authorized(request: IncomingMessage, adminToken: string): boolean {
  const supplied = Buffer.from(request.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${adminToken}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

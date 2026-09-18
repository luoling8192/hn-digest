import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readConfig } from './config.js';
import { errorCode, log } from './http.js';
import { renderMessage, renderPage } from './render.js';
import { Store } from './store.js';
import { dependencies, Worker } from './worker.js';

const config = readConfig();
const store = new Store(config.DATA_DIR);
const worker = new Worker(config, store, dependencies(config));
const startedAt = new Date().toISOString();
let stopping = false;
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const json = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
  if (path === '/healthz') return json(stopping ? 503 : 200, { status: stopping ? 'stopping' : 'ok' });
  const authorization = Buffer.from(request.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${config.ADMIN_TOKEN}`);
  if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) return json(401, { error: 'Unauthorized' });
  try {
    if (path === '/admin/status' && request.method === 'GET') return json(200, {
      startedAt, autoPublish: worker.enabled(), busy: worker.busy,
      lastCycle: worker.lastCycle ?? JSON.parse(store.setting('last_cycle') ?? 'null'),
      publications: store.all().map(p => ({ id: p.id, state: p.state, title: p.draft.summary.title, page: p.page, messageId: p.messageId, commentsSampled: p.draft.comments.length, commentCount: p.draft.commentCount, updates: p.updates })), failures: store.failures(),
    });
    if (request.method !== 'POST') return json(404, { error: 'Not found' });
    if (path === '/admin/enable') { store.setSetting('auto_publish', 'true'); return json(200, { autoPublish: true }); }
    if (path === '/admin/pause') { store.setSetting('auto_publish', 'false'); return json(200, { autoPublish: false }); }
    if (path === '/admin/run') {
      if (worker.busy) return json(409, { error: 'Worker already running' });
      void worker.cycle().catch(error => log('cycle_failed', { code: errorCode(error) }));
      return json(202, { accepted: true });
    }
    const match = path.match(/^\/admin\/(preview|publish)\/(\d+)$/);
    if (match) {
      if (worker.busy) return json(409, { error: 'Worker already running' });
      const id = Number(match[2]);
      if (!Number.isSafeInteger(id) || id <= 0) return json(400, { error: 'Invalid story ID' });
      if (match[1] === 'preview') {
        const draft = await worker.preview(id, url.searchParams.get('regenerate') === 'true');
        return json(200, { draft, content: renderPage(draft), message: renderMessage(draft, 'https://telegra.ph/preview') });
      }
      const publication = await worker.publish(id);
      return json(200, { id, state: publication.state, page: publication.page, messageId: publication.messageId });
    }
    return json(404, { error: 'Not found' });
  } catch (error) { log('admin_failed', { code: errorCode(error) }); return json(500, { error: errorCode(error) }); }
});
server.requestTimeout = 180_000;
server.listen(config.PORT, '0.0.0.0', () => log('server_started', { port: config.PORT, autoPublish: worker.enabled() }));
const poll = async () => {
  if (stopping || worker.busy || !worker.enabled()) return;
  try { await worker.cycle(); } catch (error) { log('cycle_failed', { code: errorCode(error) }); }
};
const timer = setInterval(() => void poll(), config.POLL_INTERVAL_SECONDS * 1000);
void poll();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return;
  stopping = true; clearInterval(timer); server.close();
  const drain = setInterval(() => { if (!worker.busy) { clearInterval(drain); store.close(); process.exit(0); } }, 250);
});

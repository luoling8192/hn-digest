import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createAdminServer } from '../src/admin-server.js';
import { type Draft, type Publication, readyPublication } from '../src/domain.js';
import { silentLogger } from '../src/logger.js';
import { ReadingService, type ReadingUpdate } from '../src/recommendations/service.js';
import { ReadingStore } from '../src/recommendations/store.js';
import { ArticleIndex } from '../src/reader-api/articles.js';
import { LinkStore } from '../src/reader-api/links.js';
import { ReaderApi } from '../src/reader-api/router.js';
import type { SqlitePublicationRepository } from '../src/storage/sqlite-publication-repository.js';
import { config, createHarness, draft } from './fixtures.js';

const secret = 'S'.repeat(43);
const userId = 200;

export function publicationFor(id: number, publishedAt: number, patch: Partial<Draft> = {}) {
  const base = structuredClone(draft);
  base.story = { ...base.story, id, title: `Story ${id}`, score: 200 + id };
  if (patch.summary) base.summary = patch.summary;
  const publication: Publication = {
    ...readyPublication({ ...base, ...patch, story: base.story }, publishedAt),
    state: 'published',
    page: { path: `page-${id}`, url: `https://telegra.ph/page-${id}` },
    messageId: 42,
    publishedAt,
  };
  return publication;
}

export const richSummary: Draft['summary'] = {
  format: 'narrative-v1',
  title: '用 SQLite 撑起一个小团队的生产系统',
  tags: ['SQLite', '架构'],
  quickTake: '一个小团队说明为什么单机 SQLite 足以支撑他们的生产负载，以及它的边界。',
  article: [{ heading: '背景', paragraphs: ['主要内容'] }],
  discussion: [{ text: '有人指出写入并发是 `WAL` 模式的主要限制。', commentIds: [124] }],
  rewrite: {
    sections: [
      {
        heading: '为什么选择 SQLite',
        paragraphs: [
          '团队最初使用 PostgreSQL，但运维成本过高。',
          '改用 `SQLite` 后部署只剩一个文件。',
        ],
        imageIds: ['img-1'],
      },
    ],
  },
};
export const richMedia = {
  coverImage: 'https://example.com/cover.jpg',
  images: [
    { id: 'img-1', url: 'https://example.com/figure.png', caption: '图 1：部署结构' },
    { id: 'img-2', url: 'https://example.com/cover.jpg', caption: '' },
  ],
};

async function setup(now = { value: 1_000_000 }) {
  const harness = createHarness();
  const directory = mkdtempSync(join(process.cwd(), 'reader-api-test-'));
  const store = new ReadingStore(directory);
  const repository = harness.repository as SqlitePublicationRepository;
  const links = new LinkStore(store, () => now.value);
  const api = new ReaderApi({
    articles: new ArticleIndex(repository, () => now.value, 0),
    store,
    links,
    botUsername: 'shiguang_bot',
    logger: silentLogger,
    now: () => now.value,
  });
  const server = createAdminServer({
    adminToken: config.ADMIN_TOKEN,
    service: harness.service,
    logger: silentLogger,
    readerApi: api,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      headers: response.headers,
      body: (await response.json()) as any,
    };
  };
  const link = async (id = userId) => {
    const started = await call('POST', '/link/start', { secret });
    const code = started.body.code as string;
    assert.equal(links.claim(code, id), true);
    const polled = await call('POST', '/link/poll', { code, secret });
    return { code, token: polled.body.token as string };
  };
  return {
    harness,
    repository,
    store,
    directory,
    links,
    call,
    link,
    now,
    cleanup: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(directory, { recursive: true });
      harness.cleanup();
    },
  };
}

function publish(t: Awaited<ReturnType<typeof setup>>, ...publications: Publication[]) {
  for (const publication of publications) t.repository.savePublication(publication);
}

test('article list is public, newest first, cursor paginated and only shows readable articles', async () => {
  const t = await setup();
  try {
    publish(
      t,
      publicationFor(1, 1_000),
      publicationFor(2, 3_000),
      publicationFor(3, 2_000),
      publicationFor(4, 4_000, {
        article: { text: '', source: 'unavailable', readingMinutes: null },
      }),
      { ...publicationFor(5, 5_000), state: 'ready', page: null },
    );
    const first = await t.call('GET', '/articles?limit=2');
    assert.equal(first.status, 200);
    assert.match(first.headers.get('cache-control') ?? '', /max-age=\d+/);
    assert.deepEqual(
      first.body.items.map((item: { id: number }) => item.id),
      [2, 3],
    );
    assert.ok(first.body.nextCursor);
    const second = await t.call('GET', `/articles?limit=2&cursor=${first.body.nextCursor}`);
    assert.deepEqual(
      second.body.items.map((item: { id: number }) => item.id),
      [1],
    );
    assert.equal(second.body.nextCursor, null);
    assert.deepEqual(Object.keys(first.body.items[0]).sort(), [
      'commentCount',
      'coverImageUrl',
      'hnUrl',
      'id',
      'overview',
      'publishedAt',
      'readingMinutes',
      'score',
      'sourceUrl',
      'tags',
      'title',
    ]);
    assert.equal((await t.call('GET', '/articles?cursor=zzz')).status, 400);
    assert.equal((await t.call('GET', '/articles?limit=0')).status, 400);
  } finally {
    await t.cleanup();
  }
});

test('article detail returns structured blocks, discussion citations and disclaimer', async () => {
  const t = await setup();
  try {
    publish(
      t,
      publicationFor(10, 9_000, {
        summary: richSummary,
        article: { text: 'Article text', source: 'article', readingMinutes: 3, media: richMedia },
      }),
      publicationFor(11, 8_000, {
        article: { text: '', source: 'unavailable', readingMinutes: null },
      }),
    );
    const detail = await t.call('GET', '/articles/10');
    assert.equal(detail.status, 200);
    assert.equal(detail.body.title, richSummary.title);
    assert.equal(detail.body.coverImageUrl, 'https://example.com/cover.jpg');
    assert.equal(detail.body.bodyKind, 'rewrite');
    assert.equal(detail.body.aiGenerated, true);
    assert.deepEqual(
      detail.body.body.map((block: { type: string }) => block.type),
      ['heading', 'paragraph', 'paragraph', 'image'],
    );
    assert.deepEqual(detail.body.body[2].inlines[1], { type: 'code', text: 'SQLite' });
    assert.equal(detail.body.discussion[0].citations[0].author, 'alice');
    assert.equal(
      detail.body.discussion[0].citations[0].url,
      'https://news.ycombinator.com/item?id=124',
    );
    assert.equal((await t.call('GET', '/articles/11')).status, 404);
    assert.equal((await t.call('GET', '/articles/999')).status, 404);
    assert.equal((await t.call('GET', '/articles/abc')).status, 400);
  } finally {
    await t.cleanup();
  }
});

test('public endpoints are rate limited per client', async () => {
  const t = await setup();
  try {
    let limited = null as Awaited<ReturnType<typeof t.call>> | null;
    for (let i = 0; i < 70 && !limited; i++) {
      const result = await t.call('GET', '/articles');
      if (result.status === 429) limited = result;
    }
    assert.ok(limited);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  } finally {
    await t.cleanup();
  }
});

test('link flow: pending, bot claim, token returned once, revoke', async () => {
  const t = await setup();
  try {
    const started = await t.call('POST', '/link/start', { secret });
    assert.equal(started.status, 200);
    const { code, botUrl, expiresAt } = started.body;
    assert.equal(botUrl, `https://t.me/shiguang_bot?start=link_${code}`);
    assert.equal(Date.parse(expiresAt), 1_000_000 + 600_000);
    assert.match(code, /^[A-Za-z0-9_-]{22}$/);

    assert.deepEqual((await t.call('POST', '/link/poll', { code, secret })).body, {
      status: 'pending',
    });
    // The code alone (e.g. leaked through the bot URL) is not enough to read the token.
    assert.equal(t.links.claim(code, userId), true);
    const wrong = await t.call('POST', '/link/poll', { code, secret: 'X'.repeat(43) });
    assert.equal(wrong.status, 410);
    assert.equal((await t.call('POST', '/link/poll', { code, secret: 'short' })).status, 400);

    const linked = await t.call('POST', '/link/poll', { code, secret });
    assert.equal(linked.body.status, 'linked');
    assert.match(linked.body.token, /^shg_/);
    assert.equal((await t.call('POST', '/link/poll', { code, secret })).status, 410);

    // Neither the token nor the code is stored in clear.
    const db = new DatabaseSync(join(t.directory, 'reading.sqlite'), { readOnly: true });
    const dump = JSON.stringify(db.prepare('SELECT key,data FROM reading_state').all());
    db.close();
    assert.equal(dump.includes(linked.body.token), false);
    assert.equal(dump.includes(code), false);
    assert.equal(dump.includes(secret), false);

    assert.equal((await t.call('GET', '/bookmarks', undefined, linked.body.token)).status, 200);
    assert.equal((await t.call('POST', '/link/revoke')).status, 401);
    assert.equal((await t.call('POST', '/link/revoke', {}, linked.body.token)).status, 200);
    assert.equal((await t.call('GET', '/bookmarks', undefined, linked.body.token)).status, 401);
  } finally {
    await t.cleanup();
  }
});

test('link codes expire and cannot be claimed twice', async () => {
  const t = await setup();
  try {
    const first = (await t.call('POST', '/link/start', { secret })).body.code as string;
    assert.equal(t.links.claim(first, 1), true);
    assert.equal(t.links.claim(first, 2), false);
    const token = (await t.call('POST', '/link/poll', { code: first, secret })).body.token;
    assert.equal(t.links.authenticate(token), 1);

    const stale = (await t.call('POST', '/link/start', { secret })).body.code as string;
    t.now.value += 600_001;
    assert.equal(t.links.claim(stale, 3), false);
    assert.equal((await t.call('POST', '/link/poll', { code: stale, secret })).status, 410);
    assert.equal(t.links.claim('not-a-code', 3), false);
    assert.equal((await t.call('POST', '/link/start', {})).status, 400);
    assert.equal((await t.call('POST', '/link/start', { secret: 'short' })).status, 400);
  } finally {
    await t.cleanup();
  }
});

test('bot /start link_<code> binds the sender and replies in Chinese', async () => {
  const t = await setup();
  try {
    const calls: Array<{ method: string; payload: any }> = [];
    const service = new ReadingService(
      100,
      t.store,
      {
        call: async (method, payload) => {
          calls.push({ method, payload });
          return { message_id: 1 };
        },
      },
      { refresh: async () => {} },
      {} as never,
      () => t.now.value,
      undefined,
      undefined,
      undefined,
      t.links,
    );
    const { code } = (await t.call('POST', '/link/start', { secret })).body;
    const update = (from: number, text: string): ReadingUpdate => ({
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: from, is_bot: false },
        chat: { id: from, type: 'private' },
        text,
      },
    });
    assert.equal(service.accepts(update(userId, `/start link_${code}`)), true);
    await service.handle(update(userId, `/start link_${code}`));
    assert.equal(calls.at(-1)?.payload.text, '已连接 Shiguang App');
    await service.handle(update(300, `/start link_${code}`));
    assert.match(calls.at(-1)?.payload.text, /无效或已过期/);
    const { token } = (await t.call('POST', '/link/poll', { code, secret })).body;
    assert.equal(t.links.authenticate(token), userId);
  } finally {
    await t.cleanup();
  }
});

test('bookmarks share the bot saved state, keep counts pending and stay private', async () => {
  const t = await setup();
  try {
    publish(t, publicationFor(1, 1_000), publicationFor(2, 2_000), publicationFor(3, 3_000));
    const { token } = await t.link(userId);
    const other = await t.link(201);
    assert.equal((await t.call('GET', '/bookmarks')).status, 401);
    assert.equal((await t.call('PUT', '/bookmarks/1')).status, 401);

    assert.equal((await t.call('PUT', '/bookmarks/999', undefined, token)).status, 404);
    for (const id of [1, 2, 3]) {
      t.now.value += 10;
      const saved = await t.call('PUT', `/bookmarks/${id}`, undefined, token);
      assert.deepEqual(saved.body, { articleId: id, saved: true });
    }
    // Idempotent: second PUT does not bump the revision.
    const revision = t.store.reader(userId)?.feedback[1]?.revision;
    await t.call('PUT', '/bookmarks/1', undefined, token);
    assert.equal(t.store.reader(userId)?.feedback[1]?.revision, revision);

    // Same state the bot and channel button read and write.
    const reader = t.store.reader(userId);
    assert.deepEqual(
      Object.entries(reader?.feedback ?? {})
        .filter(([, f]) => f.saved)
        .map(([id]) => Number(id))
        .sort(),
      [1, 2, 3],
    );
    assert.equal(t.store.feedbackCounts(1).saves, 1);
    assert.ok(t.store.pendingFeedbackCounts().some((p) => p.storyId === 2));
    assert.ok(t.store.article(2));

    const firstPage = await t.call('GET', '/bookmarks?limit=2', undefined, token);
    assert.deepEqual(
      firstPage.body.items.map((i: { id: number }) => i.id),
      [3, 2],
    );
    const secondPage = await t.call(
      'GET',
      `/bookmarks?limit=2&cursor=${firstPage.body.nextCursor}`,
      undefined,
      token,
    );
    assert.deepEqual(
      secondPage.body.items.map((i: { id: number }) => i.id),
      [1],
    );
    assert.equal(secondPage.body.nextCursor, null);
    assert.ok(firstPage.body.items[0].savedAt);

    assert.deepEqual((await t.call('GET', '/bookmarks', undefined, other.token)).body.items, []);

    // Bot-side removal is visible to the API and vice versa.
    const botReader = t.store.reader(userId);
    assert.ok(botReader);
    const f = botReader.feedback[2];
    assert.ok(f);
    botReader.feedback[2] = { ...f, saved: false, revision: f.revision + 1 };
    t.store.saveReader(botReader);
    assert.deepEqual(
      (await t.call('GET', '/bookmarks', undefined, token)).body.items.map(
        (i: { id: number }) => i.id,
      ),
      [3, 1],
    );
    const ackBefore = t.store.pendingFeedbackCounts().length;
    for (const pending of t.store.pendingFeedbackCounts())
      t.store.ackFeedbackCounts(pending.storyId, pending.revision);
    assert.ok(ackBefore > 0);
    assert.equal((await t.call('DELETE', '/bookmarks/3', undefined, token)).status, 200);
    assert.equal(t.store.reader(userId)?.feedback[3]?.saved, false);
    assert.equal(t.store.feedbackCounts(3).saves, 0);
    assert.deepEqual(
      t.store.pendingFeedbackCounts().map((p) => p.storyId),
      [3],
    );
    assert.equal((await t.call('DELETE', '/bookmarks/3', undefined, token)).status, 200);
    assert.equal((await t.call('PUT', '/bookmarks/x', undefined, token)).status, 400);
  } finally {
    await t.cleanup();
  }
});

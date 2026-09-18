import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { publicAddress, safeUrl } from '../src/article.js';
import { configSchema } from '../src/config.js';
import { collectComments, commentsHash } from '../src/hn.js';
import { TelegramRejected } from '../src/publish.js';
import { renderMessage, renderPage } from '../src/render.js';
import { Store } from '../src/store.js';
import { Worker, type Dependencies } from '../src/worker.js';
import type { Draft, Item } from '../src/types.js';

const config = configSchema.parse({ TELEGRAM_BOT_TOKEN: 'test-token-not-a-real-token', TELEGRAM_CHAT_ID: '-100123456789', OPENROUTER_API_KEY: 'test-key-not-a-real-key', TELEGRAPH_ACCESS_TOKEN: 'test-telegraph', ADMIN_TOKEN: 'x'.repeat(32) });
const story: Item = { id: 123, type: 'story', title: 'A & B < C', time: 100, score: 200, descendants: 10, url: 'https://example.com/article', kids: [124] };
const draft: Draft = { story, article: { text: 'Article text', source: 'article', readingMinutes: 3 }, comments: [{ id: 124, parent: 123, author: 'alice', text: 'A useful correction' }], summary: { title: '中文 & <标题>', introduction: '摘要导语', article: [{ heading: '背景', paragraphs: ['主要内容'] }], discussion: [{ heading: '不同看法', text: '用户补充', commentIds: [124] }] }, generatedAt: '2026-09-18T00:00:00Z', commentCount: 10, commentHash: 'initial' };
function setup(overrides: Partial<Dependencies> = {}) {
  const dir = mkdtempSync(join(process.cwd(), 'data-test-'));
  let sends = 0;
  const store = new Store(dir);
  const deps: Dependencies = { frontPage: async () => [story], getItem: async () => story,
    article: async () => draft.article, comments: async () => draft.comments, summarize: async () => structuredClone(draft),
    page: async () => ({ path: 'test-09-18', url: 'https://telegra.ph/test-09-18' }),
    send: async () => { sends++; return 42; }, edit: async () => {}, ...overrides };
  return { dir, store, deps, worker: new Worker(config, store, deps), sends: () => sends, cleanup: () => { store.close(); rmSync(dir, { recursive: true }); } };
}
test('published story remains deduplicated after opening the persisted database again', async () => {
  const t = setup();
  try {
    const first = await t.worker.publish(123);
    assert.equal(first.state, 'published'); assert.equal(first.messageId, 42);
    const reopened = new Store(t.dir);
    try { await new Worker(config, reopened, t.deps).publish(123); assert.equal(t.sends(), 1); }
    finally { reopened.close(); }
  } finally { t.cleanup(); }
});
test('definite Telegram rejection retries the saved page without suppressing delivery', async () => {
  let pages = 0, calls = 0;
  const t = setup({ page: async () => { pages++; return { path: 'p', url: 'https://telegra.ph/p' }; }, send: async () => { if (++calls === 1) throw new TelegramRejected('rate limited'); return 43; } });
  try {
    await assert.rejects(t.worker.publish(123)); assert.equal(t.store.get(123)?.state, 'ready');
    await t.worker.publish(123); assert.equal(pages, 1); assert.equal(calls, 2); assert.equal(t.store.get(123)?.state, 'published');
  } finally { t.cleanup(); }
});
test('ambiguous Telegram outcome never automatically resends', async () => {
  let calls = 0;
  const t = setup({ send: async () => { calls++; throw new Error('timeout'); } });
  try {
    await assert.rejects(t.worker.publish(123)); assert.equal(t.store.get(123)?.state, 'uncertain');
    await assert.rejects(t.worker.publish(123)); await t.worker.cycle(); assert.equal(calls, 1);
  } finally { t.cleanup(); }
});
test('a interrupted sending state becomes uncertain before another publish', async () => {
  const t = setup();
  try {
    const item = t.store.prepare(draft); item.state = 'sending'; t.store.put(item);
    await assert.rejects(t.worker.publish(123)); assert.equal(t.store.get(123)?.state, 'uncertain'); assert.equal(t.sends(), 0);
  } finally { t.cleanup(); }
});
test('discussion refresh edits the same page and message without posting another message', async () => {
  let editedPage = '', editedMessage = 0, summaries = 0;
  const updated = { ...story, descendants: 80, score: 250 };
  const comments = [...draft.comments, { id: 125, parent: 124, author: 'bob', text: 'Counterpoint' }];
  const t = setup({ comments: async () => comments, summarize: async () => ++summaries === 1 ? structuredClone(draft) : ({ ...draft, story: updated, comments, commentHash: commentsHash(comments), commentCount: 80 }), page: async (_, existing) => { if (existing) editedPage = existing.path; return existing ?? { path: 'same-page', url: 'https://telegra.ph/same-page' }; }, edit: async (_, __, id) => { editedMessage = id; } });
  try {
    const item = await t.worker.publish(123); item.updatedAt = Date.now() - 7200_000; t.store.put(item);
    await t.worker.refresh(item, updated);
    assert.equal(editedPage, 'same-page'); assert.equal(editedMessage, 42); assert.equal(t.sends(), 1); assert.equal(t.store.get(123)?.draft.commentCount, 80);
  } finally { t.cleanup(); }
});
test('comment traversal skips removed text and retains reply relationships', async () => {
  const items: Record<number, Item> = {
    124: { id: 124, time: 1, type: 'comment', parent: 123, by: 'alice', text: '<p>First &amp; useful</p>', kids: [125, 126] },
    125: { id: 125, time: 2, type: 'comment', parent: 124, deleted: true, kids: [] },
    126: { id: 126, time: 3, type: 'comment', parent: 124, by: 'bob', text: 'Reply', kids: [] },
  };
  const comments = await collectComments(story, async id => items[id] ?? null);
  assert.deepEqual(comments.map(c => [c.id, c.parent]), [[124, 123], [126, 124]]);
  assert.equal(comments[0]?.text, 'First & useful');
});
test('rendering keeps article and discussion separate with direct comment references', () => {
  const content = JSON.stringify(renderPage(draft));
  assert.ok(content.includes('HN 讨论摘要')); assert.ok(content.includes('item?id=124'));
  const message = renderMessage(draft, 'https://telegra.ph/test');
  assert.ok(message.text.includes('&amp; &lt;标题&gt;'));
  assert.equal(message.link_preview_options.url, 'https://telegra.ph/test');
  assert.equal(message.reply_markup.inline_keyboard[0]?.[1]?.text, '评论：10');
});
test('article fetch blocks loopback, metadata, private and mapped private addresses', () => {
  for (const address of ['127.0.0.1', '169.254.169.254', '10.1.2.3', '192.168.1.1', '::1', '::ffff:127.0.0.1', 'fc00::1']) assert.equal(publicAddress(address), false);
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.throws(() => safeUrl('http://127.0.0.1/admin'));
  assert.throws(() => safeUrl('file:///etc/passwd'));
});
test('preview creates no public page and sends no Telegram message', async () => {
  let pages = 0;
  const t = setup({ page: async () => { pages++; throw new Error('must not run'); } });
  try { await t.worker.preview(123); assert.equal(pages, 0); assert.equal(t.sends(), 0); assert.equal(t.store.get(123)?.state, 'ready'); }
  finally { t.cleanup(); }
});
test('regenerating a published draft is rejected without replacing its delivery record', async () => {
  const t = setup();
  try {
    await t.worker.publish(123);
    await assert.rejects(t.worker.preview(123, true));
    assert.equal(t.store.get(123)?.messageId, 42);
    assert.equal(t.sends(), 1);
  } finally { t.cleanup(); }
});

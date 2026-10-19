import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ReadingAssistant } from '../src/recommendations/assistant.js';
import { ReadingBackfill } from '../src/recommendations/backfill.js';
import { DeepReading, type DeepReader } from '../src/recommendations/deep-reading.js';
import { newReader, type ReadingArticle } from '../src/recommendations/model.js';
import { ReadingPoller } from '../src/recommendations/poller.js';
import { renderBatch } from '../src/recommendations/presentation.js';
import { recommend, topicWeights } from '../src/recommendations/ranking.js';
import {
  ReadingService,
  type ReadingTransport,
  type ReadingUpdate,
} from '../src/recommendations/service.js';
import { ReadingStore } from '../src/recommendations/store.js';
import { readingMessage, type ReadingMessage } from '../src/recommendations/presentation.js';
import type { StatusView } from '../src/recommendations/status.js';
import { ReadingAccess } from '../src/recommendations/access.js';
import { silentLogger } from '../src/logger.js';
import { draft, story } from './fixtures.js';

const owner = 100;

test('deep reading shares concurrent work, persists the page and never summarizes a missing source', async () => {
  const h = harness();
  let summaries = 0;
  let pages = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deep = new DeepReading(
    h.store,
    {
      getItem: async () => story,
      collectComments: async () => draft.comments,
    },
    {
      summarize: async (_story, source) => {
        summaries++;
        assert.equal(source.text, draft.article.text);
        await gate;
        return draft;
      },
    },
    {
      save: async () => {
        pages++;
        return { path: 'reading-test', url: 'https://telegra.ph/reading-test' };
      },
    },
    silentLogger,
  );
  try {
    h.store.saveSource(1, draft.article);
    const one = deep.prepare(article(1));
    const two = deep.prepare(article(1));
    release();
    const results = await Promise.all([one, two]);
    assert.equal(results[0]?.summaryUrl, 'https://telegra.ph/reading-test');
    assert.deepEqual(results[0], results[1]);
    await deep.prepare(article(1));
    await deep.prepare(article(2));
    assert.equal(summaries, 1);
    assert.equal(pages, 1);
    assert.equal(h.store.article(1)?.summaryUrl, 'https://telegra.ph/reading-test');
    assert.equal(h.store.article(2)?.summaryUrl, null);
  } finally {
    release();
    await deep.stop();
    h.cleanup();
  }
});

test('background deep reading limits concurrency and drains active work without starting queued jobs on shutdown', async () => {
  const h = harness();
  let summaries = 0;
  let refreshed = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deep = new DeepReading(
    h.store,
    {
      getItem: async () => story,
      collectComments: async () => draft.comments,
    },
    {
      summarize: async () => {
        summaries++;
        await gate;
        return draft;
      },
    },
    {
      save: async () => ({ path: 'reading-test', url: 'https://telegra.ph/reading-test' }),
    },
    silentLogger,
  );
  try {
    for (let id = 1; id <= 5; id++) h.store.saveSource(id, draft.article);
    deep.enqueue(
      [1, 2, 3, 4, 5].map((id) => article(id)),
      async () => {
        refreshed++;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(summaries, 2);
    assert.equal(refreshed, 0);
    const stopped = deep.stop();
    release();
    await stopped;
    assert.equal(summaries, 2);
    assert.equal(refreshed, 2);
    assert.equal(h.store.article(3)?.summaryUrl, null);
    deep.enqueue([article(3)], async () => {
      refreshed++;
    });
    assert.equal(summaries, 2);
  } finally {
    release();
    await deep.stop();
    h.cleanup();
  }
});
function article(id: number, topics = ['架构']): ReadingArticle {
  return {
    id,
    title: `文章 ${id}`,
    originalTitle: `Architecture ${id}`,
    url: `https://example.com/${id}`,
    summaryUrl: null,
    description: '作者解释了系统设计中的权衡。',
    topics,
    score: 500 + id,
    time: 1600000000,
    minutes: 5,
    evidence: 'fulltext',
  };
}
function message(text: string, userId = owner, replyId?: number): ReadingUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      from: { id: userId, is_bot: false },
      chat: { id: userId, type: 'private' },
      text,
      ...(replyId ? { reply_to_message: { message_id: replyId } } : {}),
    },
  };
}
function callback(
  batchId: string,
  messageId: number,
  action: string,
  userId = owner,
): ReadingUpdate {
  return {
    update_id: 2,
    callback_query: {
      id: 'callback',
      from: { id: userId, is_bot: false },
      data: `r:${batchId}:${action}`,
      message: { message_id: messageId, chat: { id: userId, type: 'private' } },
    },
  };
}
function harness(deepReader?: DeepReader, statusPanel?: (view: StatusView) => ReadingMessage) {
  const directory = mkdtempSync(join(process.cwd(), 'reading-test-'));
  const store = new ReadingStore(directory);
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  let messageId = 10;
  const transport: ReadingTransport = {
    call: async (method, payload) => {
      calls.push({ method, payload: { ...payload } });
      return { message_id: ++messageId };
    },
  };
  const assistant: ReadingAssistant = {
    annotate: async (articles) => articles,
    understand: async () => ({
      action: 'preferences',
      selection: [],
      interests: [{ name: '数据库', query: 'database', weight: 3 }],
      reply: '已更新偏好',
    }),
    explain: async () => '依据正文的回答',
  };
  const service = new ReadingService(
    owner,
    store,
    transport,
    { refresh: async () => {} },
    assistant,
    () => 1000,
    deepReader,
    statusPanel,
  );
  for (let id = 1; id <= 12; id++) store.saveArticle(article(id));
  const latest = () => {
    const reader = store.reader(owner);
    assert.ok(reader?.latestBatch);
    const batch = store.batch(reader.latestBatch);
    assert.ok(batch?.messageId);
    return { reader, batch, messageId: batch.messageId };
  };
  return {
    directory,
    store,
    calls,
    service,
    assistant,
    transport,
    latest,
    cleanup: () => {
      store.close();
      rmSync(directory, { recursive: true });
    },
  };
}

test('owner status commands and refresh buttons read fresh data without model calls or recommendations', async () => {
  let version = 1;
  const h = harness(undefined, (view) => readingMessage(`${view} ${version}`));
  h.assistant.understand = async () => {
    throw new Error('Status must not invoke the model');
  };
  try {
    await h.service.handle(message('/status'));
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]?.method, 'sendMessage');
    assert.equal(h.calls[0]?.payload.chat_id, owner);
    assert.equal(h.calls[0]?.payload.text, 'overview 1');
    assert.equal(h.store.reader(owner), null);
    version = 2;
    const update = callback('ignored', 11, 'ignored');
    assert.ok(update.callback_query);
    update.callback_query.data = 'ops:failures';
    await h.service.handle(update);
    assert.equal(h.calls[1]?.method, 'answerCallbackQuery');
    assert.equal(h.calls[2]?.method, 'editMessageText');
    assert.equal(h.calls[2]?.payload.message_id, 11);
    assert.equal(h.calls[2]?.payload.text, 'failures 2');
    await h.service.handle(message('运行状态'));
    assert.equal(h.calls.at(-1)?.payload.text, 'overview 2');
  } finally {
    h.cleanup();
  }
});

test('owner grants persist and guest reading stays isolated from owner data and administration', async () => {
  const h = harness(undefined, () => {
    throw new Error('Guest read admin status');
  });
  try {
    await h.service.handle(message('/allow 200'));
    const reopened = new ReadingStore(h.directory);
    try {
      assert.equal(new ReadingAccess(owner, reopened, h.transport).allowed(200), true);
    } finally {
      reopened.close();
    }
    await h.service.handle(message('推荐', 200));
    const guest = h.store.reader(200);
    assert.ok(guest?.latestBatch);
    const guestBatch = h.store.batch(guest.latestBatch);
    assert.ok(guestBatch?.messageId);
    assert.equal(guestBatch.userId, 200);
    assert.equal(h.calls.at(-1)?.payload.chat_id, 200);
    assert.equal(h.store.reader(owner), null);
    await h.service.handle(message('我喜欢数据库', 200));
    assert.equal(h.store.reader(200)?.interests[0]?.name, '数据库');
    await h.service.handle(message('推荐'));
    const own = h.latest();
    await h.service.handle(callback(own.batch.id, guestBatch.messageId, 'select:1', 200));
    assert.deepEqual(h.store.batch(own.batch.id)?.selected, []);
    const before = h.calls.length;
    await h.service.handle(message('/status', 200));
    await h.service.handle(message('/allow 300', 200));
    for (const data of [
      'ops:overview',
      'ops:failures',
      'ops:users',
      'ops:add',
      'ops:grant:300',
      'ops:revoke:100',
    ]) {
      const update = callback('ignored', guestBatch.messageId, 'ignored', 200);
      assert.ok(update.callback_query);
      update.callback_query.data = data;
      await h.service.handle(update);
    }
    assert.equal(h.calls.length, before);
    assert.equal(h.service.accepts(message('推荐', 300)), false);
    await h.service.reportFailure(message('推荐', 200));
    assert.equal(h.calls.at(-1)?.payload.chat_id, 200);
    await h.service.handle(message('/deny 200'));
    const after = h.calls.length;
    await h.service.handle(message('推荐', 200));
    await h.service.handle(callback(guestBatch.id, guestBatch.messageId, 'save', 200));
    await h.service.reportFailure(message('推荐', 200));
    assert.equal(h.calls.length, after);
    assert.equal(h.store.reader(200)?.latestBatch, guest.latestBatch);
    await h.service.handle(message('/allow 200'));
    assert.equal(h.service.accepts(message('推荐', 200)), true);
    await h.service.handle(message('/deny 100'));
    assert.equal(h.service.accepts(message('/status')), true);
  } finally {
    h.cleanup();
  }
});

test('panel UID prompt validates input and unauthorized users can only discover their own UID', async () => {
  const h = harness();
  try {
    await h.service.handle(message('/id', 200));
    assert.equal(h.calls.at(-1)?.payload.chat_id, 200);
    assert.match(String(h.calls.at(-1)?.payload.text), /200/);
    assert.equal(h.store.reader(200), null);
    const update = callback('ignored', 10, 'ignored');
    assert.ok(update.callback_query);
    update.callback_query.data = 'ops:add';
    await h.service.handle(update);
    assert.match(String(h.calls.at(-1)?.payload.text), /请发送对方/);
    await h.service.handle(message('99999999999999999999999'));
    assert.match(String(h.calls.at(-1)?.payload.text), /有效的正整数/);
    await h.service.handle(message('200'));
    assert.equal(h.service.accepts(message('推荐', 200)), true);
    assert.match(String(h.calls.at(-1)?.payload.text), /200 · 已开启/);
    const disable = callback('ignored', 10, 'ignored');
    assert.ok(disable.callback_query);
    disable.callback_query.data = 'ops:revoke:200';
    await h.service.handle(disable);
    assert.equal(h.service.accepts(message('推荐', 200)), false);
    assert.match(String(h.calls.at(-1)?.payload.text), /200 · 已停用/);
  } finally {
    h.cleanup();
  }
});

test('status data rejects non-owner users, group commands and forwarded refresh buttons', async () => {
  const h = harness(undefined, () => {
    throw new Error('Unauthorized status read');
  });
  try {
    await h.service.handle(message('/status', 999));
    const group = message('/status');
    assert.ok(group.message);
    group.message.chat = { id: -100, type: 'group' };
    await h.service.handle(group);
    const forwarded = callback('ignored', 10, 'ignored', 999);
    assert.ok(forwarded.callback_query);
    forwarded.callback_query.data = 'ops:overview';
    await h.service.handle(forwarded);
    const otherChat = callback('ignored', 10, 'ignored');
    assert.ok(otherChat.callback_query?.message);
    otherChat.callback_query.data = 'ops:overview';
    otherChat.callback_query.message.chat.id = 999;
    await h.service.handle(otherChat);
    assert.deepEqual(h.calls, []);
  } finally {
    h.cleanup();
  }
});

test('deep page completion updates the existing batch without losing selection and startup resumes without another message', async () => {
  const callbacks: (() => Promise<void>)[] = [];
  const queued: number[][] = [];
  const h = harness({
    prepare: async (article) => article,
    enqueue: (articles, onReady) => {
      queued.push(articles.map((article) => article.id));
      callbacks.push(onReady);
    },
  });
  try {
    await h.service.handle(message('推荐'));
    const { batch, messageId } = h.latest();
    assert.deepEqual(queued[0], batch.articleIds);
    await h.service.handle(callback(batch.id, messageId, 'select:1'));
    const first = h.store.article(batch.articleIds[0] ?? 0);
    assert.ok(first);
    h.store.saveArticle({ ...first, summaryUrl: 'https://telegra.ph/ready' });
    const ready = callbacks[0];
    assert.ok(ready);
    await ready();
    const edited = h.calls.at(-1);
    assert.equal(edited?.method, 'editMessageText');
    assert.equal(edited?.payload.message_id, messageId);
    assert.match(String(edited?.payload.text), /https:\/\/telegra.ph\/ready/);
    assert.deepEqual(h.store.batch(batch.id)?.selected, [first.id]);
    h.service.resumeDeepReading();
    assert.deepEqual(queued[1], batch.articleIds);
    assert.equal(h.calls.filter((call) => call.method === 'sendMessage').length, 1);
  } finally {
    h.cleanup();
  }
});

test('private reader binds trusted numeric identity; foreign users and groups cannot access preferences or buttons', async () => {
  const h = harness();
  try {
    await h.service.handle(message('/start', 200));
    const group = message('/start');
    if (group.message) group.message.chat = { id: -100, type: 'supergroup' };
    await h.service.handle(group);
    assert.equal(h.calls.length, 0);
    assert.equal(h.store.reader(owner), null);
    await h.service.handle(message('/start'));
    const { batch, messageId } = h.latest();
    assert.equal(h.store.reader(owner)?.userId, owner);
    const previousCalls = h.calls.length;
    await h.service.handle(callback(batch.id, messageId, 'select:1', 200));
    assert.equal(h.calls.length, previousCalls);
    assert.deepEqual(h.store.batch(batch.id)?.selected, []);
    await h.service.handle(callback(batch.id, messageId + 500, 'select:1'));
    assert.deepEqual(h.store.batch(batch.id)?.selected, []);
  } finally {
    h.cleanup();
  }
});

test('five-article batch supports selection, atomic bookmarking, repeated clicks and revision-safe undo', async () => {
  const h = harness();
  try {
    await h.service.handle(message('推荐'));
    const { batch, messageId } = h.latest();
    assert.equal(batch.articleIds.length, 5);
    const first = batch.articleIds[0];
    const third = batch.articleIds[2];
    assert.ok(first && third);
    await h.service.handle(callback(batch.id, messageId, 'select:1'));
    await h.service.handle(callback(batch.id, messageId, 'select:3'));
    assert.deepEqual(h.store.reader(owner)?.feedback, {});
    assert.deepEqual(h.store.batch(batch.id)?.selected, [first, third]);
    await h.service.handle(callback(batch.id, messageId, 'save'));
    assert.equal(h.store.reader(owner)?.feedback[first]?.saved, true);
    assert.equal(h.store.reader(owner)?.feedback[third]?.saved, true);
    await h.service.handle(callback(batch.id, messageId, 'save'));
    assert.equal(h.store.reader(owner)?.feedback[first]?.revision, 1);
    await h.service.handle(message('收藏 1、3', owner, messageId));
    assert.equal(h.store.reader(owner)?.feedback[first]?.revision, 1);
    await h.service.handle(message('喜欢 1', owner, messageId));
    assert.equal(h.store.reader(owner)?.feedback[first]?.opinion, 1);
    await h.service.handle(callback(batch.id, messageId, 'undo'));
    assert.equal(h.store.reader(owner)?.feedback[first]?.saved, true);
    assert.equal(h.store.reader(owner)?.feedback[first]?.opinion, 0);
    assert.equal(h.calls.filter((call) => call.method === 'sendMessage').length, 1);
  } finally {
    h.cleanup();
  }
});

test('replying to an old batch acts on its stable numbering; next batch excludes already shown articles', async () => {
  const h = harness();
  try {
    await h.service.handle(message('推荐'));
    const first = h.latest();
    await h.service.handle(callback(first.batch.id, first.messageId, 'more'));
    const second = h.latest();
    assert.equal(
      second.batch.articleIds.some((id) => first.batch.articleIds.includes(id)),
      false,
    );
    await h.service.handle(message('收藏 2、4', owner, first.messageId));
    const savedIds = Object.keys(h.store.reader(owner)?.feedback ?? {}).map(Number);
    assert.deepEqual(
      savedIds.sort(),
      [first.batch.articleIds[1], first.batch.articleIds[3]].sort(),
    );
    await h.service.handle(message('收藏 1', owner, 99999));
    assert.equal(Object.keys(h.store.reader(owner)?.feedback ?? {}).length, 2);
    await h.service.handle(callback(second.batch.id, second.messageId, 'select:1'));
    await h.service.handle(callback(second.batch.id, second.messageId, 'more'));
    assert.equal(h.latest().batch.id, second.batch.id);
  } finally {
    h.cleanup();
  }
});

test('saved list pages edit in place and preferences survive reopening SQLite', async () => {
  const h = harness();
  try {
    await h.service.handle(message('推荐'));
    const reader = h.store.reader(owner);
    assert.ok(reader);
    for (let id = 1; id <= 7; id++)
      reader.feedback[id] = { saved: true, opinion: 0, revision: 1, savedAt: id };
    h.store.saveReader(reader);
    await h.service.handle(message('我的收藏'));
    const saved = h.latest();
    assert.deepEqual(saved.batch.articleIds, [7, 6, 5, 4, 3]);
    const sends = h.calls.filter((c) => c.method === 'sendMessage').length;
    await h.service.handle(callback(saved.batch.id, saved.messageId, 'next'));
    assert.deepEqual(h.store.batch(saved.batch.id)?.articleIds, [2, 1]);
    assert.equal(h.calls.filter((c) => c.method === 'sendMessage').length, sends);
    await h.service.handle(message('我喜欢数据库'));
    const reopened = new ReadingStore(h.directory);
    try {
      assert.equal(reopened.reader(owner)?.interests[0]?.name, '数据库');
      assert.equal(reopened.reader(owner)?.feedback[7]?.saved, true);
      assert.equal(reopened.batch(saved.batch.id)?.page, 1);
    } finally {
      reopened.close();
    }
  } finally {
    h.cleanup();
  }
});

test('ranking never recommends title-only records; feedback affects related topics without duplicate weighting', () => {
  const reader = newReader(owner);
  reader.interests = [];
  const articles = [
    article(1, ['数据库']),
    article(2, ['数据库']),
    article(3, ['创业']),
    { ...article(4), evidence: 'title' as const, score: 99999 },
  ];
  reader.feedback[1] = { saved: true, opinion: 1, revision: 1, savedAt: 1 };
  assert.equal(recommend(reader, articles)[0]?.article.id, 2);
  assert.equal(
    recommend(reader, articles).some((item) => item.article.id === 4),
    false,
  );
  assert.equal(topicWeights(reader, articles).get('数据库'), 4);
  reader.feedback[2] = { saved: false, opinion: -1, revision: 1, savedAt: 0 };
  assert.equal(
    recommend(reader, articles).some((item) => item.article.id === 2),
    false,
  );
});

test('recommendation rendering escapes external titles, disables previews and keeps callback data within Telegram limits', async () => {
  const h = harness();
  try {
    h.store.saveArticle({ ...article(12), title: '<b>not markup & test</b>' });
    await h.service.handle(message('推荐'));
    const { reader, batch } = h.latest();
    const rendered = renderBatch(batch, reader, h.store.articles());
    assert.match(rendered.text, /&lt;b&gt;not markup &amp; test/);
    assert.equal(rendered.link_preview_options.is_disabled, true);
    assert.ok(rendered.text.length < 4096);
    assert.equal(rendered.reply_markup.inline_keyboard[0]?.length, 5);
    assert.ok(
      rendered.reply_markup.inline_keyboard
        .flat()
        .every((button) => Buffer.byteLength(button.callback_data) <= 64),
    );
  } finally {
    h.cleanup();
  }
});

test('poller persists cursor before effects and never replays processed Telegram updates', async () => {
  const h = harness();
  try {
    const update = { ...message('推荐'), update_id: 90 };
    const transport: ReadingTransport = { call: async () => [update] };
    const poller = new ReadingPoller(h.store, transport, h.service, silentLogger);
    await poller.pollOnce();
    assert.equal(h.store.offset, 91);
    const calls = h.calls.length;
    await poller.pollOnce();
    assert.equal(h.calls.length, calls);
    const reopened = new ReadingStore(h.directory);
    try {
      assert.equal(reopened.offset, 91);
    } finally {
      reopened.close();
    }
  } finally {
    h.cleanup();
  }
});

test('backfill indexes metadata without model calls, then requires retrieved text before creating recommendations', async () => {
  const h = harness();
  let annotations = 0;
  const assistant: ReadingAssistant = {
    ...h.assistant,
    annotate: async (articles, _reader, sources) => {
      annotations += 1;
      assert.ok((sources.get(500)?.text.length ?? 0) >= 200);
      return articles;
    },
  };
  const backfill = new ReadingBackfill(
    h.store,
    {
      request: async () => ({
        hits: [
          {
            objectID: '500',
            title: 'Architecture lessons',
            url: 'https://example.com/archive',
            points: 600,
            num_comments: 20,
            created_at_i: 1600000000,
          },
          {
            objectID: '501',
            title: 'Ask HN: architecture',
            points: 200,
            num_comments: 12,
            created_at_i: 1600000000,
          },
          {
            objectID: '502',
            title: 'Ask HN: startups',
            url: null,
            points: 200,
            num_comments: 12,
            created_at_i: 1600000000,
          },
        ],
      }),
    },
    {
      extract: async () => ({
        text: 'Real article content. '.repeat(100),
        source: 'article',
        readingMinutes: 3,
      }),
    },
    assistant,
    owner,
    silentLogger,
    1,
    () => 1789948800000,
  );
  try {
    await backfill.step();
    assert.equal(h.store.inventory().indexed, 1);
    assert.equal(h.store.candidate(501), null);
    assert.equal(h.store.candidate(502), null);
    assert.equal(annotations, 0);
    assert.equal(h.store.article(500), null);
    h.store.put('archive:state', { month: 60, anchor: 1789948800000, lastStep: null });
    assert.equal(await backfill.step(), true);
    assert.equal(h.store.article(500)?.evidence, 'fulltext');
    assert.equal(h.store.candidate(500)?.status, 'ready');
    assert.ok(h.store.source(500)?.text);
    assert.equal(annotations, 1);
    await backfill.step();
    assert.equal(annotations, 1);
  } finally {
    h.cleanup();
  }
});

test('unavailable articles and challenge pages stay out of the recommendation pool', async () => {
  const h = harness();
  let annotations = 0;
  try {
    h.store.put('archive:state', { month: 60, anchor: Date.now(), lastStep: null });
    for (const id of [500, 501])
      h.store.saveCandidate({
        id,
        title: 'Architecture',
        url: 'https://example.com',
        score: 700,
        comments: 30,
        time: 1600000000,
        topics: ['架构'],
        status: 'pending',
        attemptedAt: null,
      });
    const backfill = new ReadingBackfill(
      h.store,
      {
        request: async () => {
          throw new Error('Unexpected index request');
        },
      },
      {
        extract: async (story) =>
          story.id === 500
            ? { text: '', source: 'unavailable', readingMinutes: null }
            : { text: 'Verify you are human. '.repeat(20), source: 'article', readingMinutes: 1 },
      },
      {
        ...h.assistant,
        annotate: async (articles) => {
          annotations++;
          return articles;
        },
      },
      owner,
      silentLogger,
      2,
    );
    await backfill.step();
    assert.equal(annotations, 0);
    assert.equal(h.store.inventory().failed, 2);
    assert.equal(h.store.article(500), null);
    assert.equal(h.store.article(501), null);
  } finally {
    h.cleanup();
  }
});

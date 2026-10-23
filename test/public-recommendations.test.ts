import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { type Batch, newReader, type ReadingArticle } from '../src/recommendations/model.js';
import {
  ReadingService,
  type ReadingTransport,
  type ReadingUpdate,
} from '../src/recommendations/service.js';
import { ReadingStore } from '../src/recommendations/store.js';

const ownerId = 100;
const userId = 200;
let updateId = 0;

function message(text: string, id = userId): ReadingUpdate {
  return {
    update_id: ++updateId,
    message: {
      message_id: updateId,
      from: { id, is_bot: false },
      chat: { id, type: 'private' },
      text,
    },
  };
}

function callback(batch: Batch, action: string, id = userId): ReadingUpdate {
  assert.ok(batch.messageId);
  return {
    update_id: ++updateId,
    callback_query: {
      id: `public-recommendation-${updateId}`,
      from: { id, is_bot: false },
      data: `r:${batch.id}:${action}`,
      message: { message_id: batch.messageId, chat: { id, type: 'private' } },
    },
  };
}

function article(id: number, topics = ['数据库']): ReadingArticle {
  return {
    id,
    title: `文章 ${id}`,
    originalTitle: `Article ${id}`,
    url: `https://example.com/${id}`,
    summaryUrl: id % 2 === 0 ? `https://telegra.ph/article-${id}` : null,
    description: `正文摘要 ${id}`,
    topics,
    score: 200,
    time: 1600000000,
    minutes: 5,
    evidence: 'fulltext',
  };
}

function actions(payload: Record<string, unknown>): string[] {
  const keyboard = payload.reply_markup as {
    inline_keyboard: { callback_data: string }[][];
  };
  return keyboard.inline_keyboard.flat().map((button) => button.callback_data.split(':')[2] ?? '');
}

function harness(articleCount = 12) {
  const directory = mkdtempSync(join(process.cwd(), 'public-recommendations-test-'));
  let store = new ReadingStore(directory);
  let currentTime = Date.UTC(2026, 9, 23, 12);
  let sentId = 100;
  let failNextSend = false;
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const paid = { understand: 0, annotate: 0, explain: 0, prepare: 0, enqueue: 0 };
  let catalogCalls = 0;
  const forbidden = async (method: keyof typeof paid): Promise<never> => {
    paid[method]++;
    throw new Error(`Public recommendations must not call ${method}`);
  };
  const transport: ReadingTransport = {
    call: async (method, payload) => {
      calls.push({ method, payload: { ...payload } });
      if (method === 'sendMessage' && failNextSend) {
        failNextSend = false;
        throw new Error('Telegram rejected the message');
      }
      return { message_id: ++sentId };
    },
  };
  const createService = () =>
    new ReadingService(
      ownerId,
      store,
      transport,
      {
        refresh: async () => {
          catalogCalls++;
        },
      },
      {
        understand: async () => forbidden('understand'),
        annotate: async () => forbidden('annotate'),
        explain: async () => forbidden('explain'),
      },
      () => currentTime,
      {
        prepare: async () => forbidden('prepare'),
        enqueue: () => {
          paid.enqueue++;
          throw new Error('Public recommendations must not enqueue paid reading');
        },
      },
    );
  let service = createService();
  const addArticles = (count: number) => {
    for (let id = 1; id <= count; id++)
      store.saveArticle(article(id, id <= 6 ? ['数据库'] : ['编程语言']));
  };
  addArticles(articleCount);
  return {
    calls,
    paid,
    get store() {
      return store;
    },
    get service() {
      return service;
    },
    get catalogCalls() {
      return catalogCalls;
    },
    addArticles,
    advance(milliseconds: number) {
      currentTime += milliseconds;
    },
    async dispatch(update: ReadingUpdate, advance = 2000) {
      currentTime += advance;
      await service.handle(update);
    },
    latest(id = userId): Batch {
      const reader = store.reader(id);
      assert.ok(reader?.latestBatch, 'A successful recommendation must persist its batch');
      const batch = store.batch(reader.latestBatch);
      assert.ok(batch?.messageId);
      return batch;
    },
    lastMessage() {
      const call = calls.at(-1);
      assert.ok(call);
      return call.payload;
    },
    rejectNextSend() {
      failNextSend = true;
    },
    restart() {
      store.close();
      store = new ReadingStore(directory);
      service = createService();
    },
    cleanup() {
      store.close();
      rmSync(directory, { recursive: true });
    },
  };
}

test('revoked AI grants stop automatic deep-page delivery while public feedback stays available', async () => {
  const h = harness();
  const refreshes: Array<() => Promise<void>> = [];
  const forbidden = async (): Promise<never> => {
    throw new Error('No model call is required to exercise an existing deep-page completion');
  };
  const service = new ReadingService(
    ownerId,
    h.store,
    {
      call: async (method, payload) => {
        h.calls.push({ method, payload: { ...payload } });
        return { message_id: h.calls.length + 100 };
      },
    },
    { refresh: async () => {} },
    { annotate: forbidden, understand: forbidden, explain: forbidden },
    () => Date.UTC(2026, 9, 23),
    { prepare: forbidden, enqueue: (_articles, onReady) => refreshes.push(onReady) },
  );
  try {
    h.store.put('access:grants', [{ userId, enabled: true }]);
    await service.handle(message('/recommend'));
    const batch = h.latest();
    assert.equal(refreshes.length, 1);
    await service.handle(message(`/deny ${userId}`, ownerId));
    const before = h.calls.length;
    await refreshes[0]?.();
    assert.equal(h.calls.length, before, 'A revoked AI job must not edit or send its result');
    await service.handle(callback(batch, 'select:1'));
    assert.equal(h.calls.length, before + 2);
    assert.equal(h.calls.at(-1)?.method, 'editMessageText');
    assert.doesNotMatch(
      JSON.stringify(h.calls.at(-1)?.payload.reply_markup),
      /explain|preferences/,
    );
  } finally {
    h.cleanup();
  }
});

test('revoking AI during an on-demand page build prevents later page edits and answers', async () => {
  const h = harness();
  let begin = () => {};
  let finish = () => {};
  const entered = new Promise<void>((resolve) => {
    begin = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const forbidden = async (): Promise<never> => {
    throw new Error('No model call is required for a controlled page completion');
  };
  const service = new ReadingService(
    ownerId,
    h.store,
    {
      call: async (method, payload) => {
        h.calls.push({ method, payload: { ...payload } });
        return { message_id: h.calls.length + 100 };
      },
    },
    { refresh: async () => {} },
    { annotate: forbidden, understand: forbidden, explain: forbidden },
    () => Date.UTC(2026, 9, 23),
    {
      prepare: async (original) => {
        begin();
        await gate;
        const prepared = { ...original, summaryUrl: 'https://telegra.ph/new-ai-page' };
        h.store.saveArticle(prepared);
        return prepared;
      },
      enqueue: () => {},
    },
  );
  let pending: Promise<unknown> | undefined;
  try {
    h.store.put('access:grants', [{ userId, enabled: true }]);
    await service.handle(message('/recommend'));
    const batch = h.latest();
    const index = batch.articleIds.findIndex((id) => id % 2 === 1);
    assert.ok(index >= 0);
    await service.handle(callback(batch, `select:${index + 1}`));
    pending = service.handle(callback(batch, 'explain')).then(
      () => null,
      (error) => error,
    );
    await entered;
    await service.handle(message(`/deny ${userId}`, ownerId));
    const before = h.calls.length;
    finish();
    const error = await pending;
    assert.equal(h.calls.length, before, 'Revocation must stop page edits as well as text replies');
    assert.equal(error, null);
  } finally {
    finish();
    await pending;
    h.cleanup();
  }
});

test('all private readers get five existing readable articles with isolated deterministic preferences and links', async () => {
  const h = harness();
  try {
    const reader = newReader(userId);
    reader.interests = [];
    reader.feedback[1] = { saved: true, opinion: 1, revision: 1, savedAt: 1 };
    h.store.saveReader(reader);
    const other = newReader(300);
    other.interests = [];
    other.feedback[7] = { saved: true, opinion: 1, revision: 1, savedAt: 1 };
    h.store.saveReader(other);
    h.store.saveArticle({ ...article(99), evidence: 'title', score: 99999 });
    h.store.saveArticle({ ...article(98), score: 149 });

    assert.equal(h.service.accepts(message('/recommend@shiguangbot')), true);
    await h.dispatch(message('/recommend@shiguangbot'));
    const first = h.latest();
    assert.equal(first.kind, 'recommendations');
    assert.equal(first.articleIds.length, 5);
    assert.equal(first.articleIds[0], 6);
    assert.equal(new Set(first.articleIds).size, 5);
    assert.equal(
      first.articleIds.some((id) => [1, 98, 99].includes(id)),
      false,
    );
    const text = String(h.lastMessage().text);
    for (const id of first.articleIds)
      assert.ok(
        text.includes(
          id % 2 === 0 ? `https://telegra.ph/article-${id}` : `https://example.com/${id}`,
        ),
      );
    assert.equal(h.lastMessage().chat_id, userId);
    assert.equal(actions(h.lastMessage()).includes('preferences'), false);
    assert.equal(actions(h.lastMessage()).includes('more'), true);

    assert.equal(h.service.accepts(message('推荐', 300)), true);
    await h.dispatch(message('推荐', 300));
    assert.equal(h.latest(300).articleIds[0], 12);
    assert.deepEqual(h.store.reader(userId)?.feedback, reader.feedback);
    assert.deepEqual(h.store.reader(300)?.feedback, other.feedback);
    assert.equal(h.store.reader(ownerId), null);
    assert.deepEqual(h.paid, { understand: 0, annotate: 0, explain: 0, prepare: 0, enqueue: 0 });
    assert.equal(h.catalogCalls, 1);
  } finally {
    h.cleanup();
  }
});

test('public recommendation callbacks select, save, like, reduce, clear, undo and show saved without paid paths', async () => {
  const h = harness(20);
  try {
    await h.dispatch(message('/recommend'));
    const batch = h.latest();
    const first = batch.articleIds[0];
    const second = batch.articleIds[1];
    assert.ok(first && second);
    await h.dispatch(callback(batch, 'select:1'));
    assert.deepEqual(h.store.batch(batch.id)?.selected, [first]);
    assert.deepEqual(
      new Set(actions(h.lastMessage())),
      new Set(['select', 'save', 'like', 'less', 'clear']),
    );
    await h.dispatch(callback(batch, 'save'));
    assert.equal(h.store.reader(userId)?.feedback[first]?.saved, true);
    await h.dispatch(callback(batch, 'undo'));
    assert.equal(h.store.reader(userId)?.feedback[first]?.saved, false);
    await h.dispatch(callback(batch, 'select:1'));
    await h.dispatch(callback(batch, 'like'));
    assert.equal(h.store.reader(userId)?.feedback[first]?.opinion, 1);
    await h.dispatch(callback(batch, 'select:2'));
    await h.dispatch(callback(batch, 'less'));
    assert.equal(h.store.reader(userId)?.feedback[second]?.opinion, -1);
    await h.dispatch(callback(batch, 'select:1'));
    await h.dispatch(callback(batch, 'clear'));
    assert.deepEqual(h.store.batch(batch.id)?.selected, []);
    await h.dispatch(callback(batch, 'select:1'));
    await h.dispatch(callback(batch, 'save'));
    await h.dispatch(callback(batch, 'saved'));
    assert.equal(h.latest().kind, 'saved');
    assert.deepEqual(h.latest().articleIds, [first]);
    h.advance(30_000);
    await h.dispatch(callback(batch, 'more'));
    const next = h.latest();
    assert.equal(next.kind, 'recommendations');
    assert.equal(next.articleIds.length, 5);
    assert.equal(
      next.articleIds.some((id) => batch.articleIds.includes(id)),
      false,
    );
    assert.deepEqual(h.paid, { understand: 0, annotate: 0, explain: 0, prepare: 0, enqueue: 0 });
  } finally {
    h.cleanup();
  }
});

test('public commands and callbacks cannot open AI, manage access, impersonate users or mutate copied batches', async () => {
  const h = harness();
  try {
    await h.dispatch(message('/recommend'));
    const batch = h.latest();
    await h.dispatch(callback(batch, 'select:1'));
    const before = h.calls.length;
    const reader = h.store.reader(userId);
    for (const text of [
      '/preferences',
      '我喜欢数据库',
      '聊聊第 1 篇',
      '/users',
      '/allow 300',
      '/status',
    ]) {
      const update = message(text);
      assert.equal(h.service.accepts(update), false, text);
      await h.dispatch(update);
    }
    for (const action of ['explain', 'preferences']) {
      const update = callback(batch, action);
      assert.equal(h.service.accepts(update), false, action);
      await h.dispatch(update);
    }
    for (const action of ['select:1', 'save', 'like', 'less', 'clear', 'undo', 'more', 'saved']) {
      const foreign = callback(batch, action, 300);
      assert.equal(h.service.accepts(foreign), false, `foreign ${action}`);
      await h.dispatch(foreign);
      const copied = callback(batch, action);
      assert.ok(copied.callback_query?.message);
      copied.callback_query.message.message_id++;
      assert.equal(h.service.accepts(copied), false, `copied ${action}`);
      await h.dispatch(copied);
    }
    const group = message('/recommend');
    assert.ok(group.message);
    group.message.chat = { id: -100, type: 'supergroup' };
    const mismatch = message('/recommend');
    assert.ok(mismatch.message);
    mismatch.message.chat.id = 300;
    const bot = message('/recommend');
    assert.ok(bot.message?.from);
    bot.message.from.is_bot = true;
    for (const update of [group, mismatch, bot]) {
      assert.equal(h.service.accepts(update), false);
      await h.dispatch(update);
    }
    assert.equal(h.calls.length, before);
    assert.deepEqual(h.store.reader(userId), reader);
    assert.deepEqual(h.store.batch(batch.id)?.selected, batch.articleIds.slice(0, 1));
    assert.equal(h.store.reader(300), null);
    assert.deepEqual(h.paid, { understand: 0, annotate: 0, explain: 0, prepare: 0, enqueue: 0 });
  } finally {
    h.cleanup();
  }
});

test('recommendation cooldown persists across restart and is independent between users', async () => {
  const h = harness(20);
  try {
    await h.dispatch(message('/recommend'), 0);
    const first = h.latest();
    h.restart();
    await h.dispatch(message('推荐'), 29_999);
    assert.equal(h.latest().id, first.id);
    assert.match(String(h.lastMessage().text), /稍后|频繁|秒|冷却/);
    await h.dispatch(message('/recommend', 300), 0);
    assert.equal(h.latest(300).articleIds.length, 5);
    await h.dispatch(message('/recommend'), 1);
    assert.notEqual(h.latest().id, first.id);
    assert.equal(
      h.latest().articleIds.some((id) => first.articleIds.includes(id)),
      false,
    );
    assert.deepEqual(h.paid, { understand: 0, annotate: 0, explain: 0, prepare: 0, enqueue: 0 });
  } finally {
    h.cleanup();
  }
});

test('daily recommendation quota survives restart, leaves saves available, and resets the next day', async () => {
  const h = harness(110);
  try {
    for (let index = 0; index < 20; index++) {
      await h.dispatch(message('/recommend'), 30_000);
      assert.equal(h.latest().articleIds.length, 5);
    }
    const last = h.latest();
    assert.equal(h.store.reader(userId)?.seen.length, 100);
    h.restart();
    await h.dispatch(message('/recommend'), 30_000);
    assert.equal(h.latest().id, last.id);
    assert.match(String(h.lastMessage().text), /今天|今日|每日|明天|20/);
    await h.dispatch(callback(last, 'select:1'));
    await h.dispatch(callback(last, 'save'));
    assert.equal(h.store.reader(userId)?.feedback[last.articleIds[0] ?? 0]?.saved, true);
    await h.dispatch(message('/saved'));
    assert.equal(h.latest().kind, 'saved');
    h.advance(24 * 60 * 60 * 1000);
    await h.dispatch(message('/recommend'));
    assert.equal(h.latest().kind, 'recommendations');
    assert.equal(h.latest().articleIds.length, 5);
    assert.equal(h.store.reader(userId)?.seen.length, 105);
    assert.deepEqual(h.paid, { understand: 0, annotate: 0, explain: 0, prepare: 0, enqueue: 0 });
  } finally {
    h.cleanup();
  }
});

test('empty inventory and rejected Telegram delivery do not spend the recommendation quota or mark unseen articles as seen', async () => {
  const h = harness(0);
  try {
    await h.dispatch(message('/recommend'), 0);
    assert.equal(h.store.reader(userId)?.latestBatch ?? null, null);
    assert.match(String(h.lastMessage().text), /文章|收藏/);
    h.addArticles(12);
    h.rejectNextSend();
    await assert.rejects(h.dispatch(message('/recommend'), 0), /Telegram rejected/);
    assert.equal(h.store.reader(userId)?.latestBatch ?? null, null);
    assert.deepEqual(h.store.reader(userId)?.seen ?? [], []);
    await h.dispatch(message('/recommend'), 0);
    assert.equal(h.latest().articleIds.length, 5);
    assert.equal(h.store.reader(userId)?.seen.length, 5);
    assert.deepEqual(h.paid, { understand: 0, annotate: 0, explain: 0, prepare: 0, enqueue: 0 });
  } finally {
    h.cleanup();
  }
});

test('start saved opens the collection directly for both public and AI-granted readers without generating recommendations', async () => {
  const h = harness();
  try {
    h.store.put('access:grants', [{ userId: 300, enabled: true }]);
    for (const id of [userId, 300, ownerId]) {
      const reader = newReader(id);
      reader.feedback[1] = { saved: true, opinion: 0, revision: 1, savedAt: 1 };
      h.store.saveReader(reader);
      await h.dispatch(message('/start@shiguangbot saved', id));
      assert.equal(h.latest(id).kind, 'saved');
      assert.deepEqual(h.latest(id).articleIds, [1]);
      assert.deepEqual(h.store.reader(id)?.seen, []);
      assert.match(String(h.lastMessage().text), /我的收藏/);
    }
    assert.equal(h.catalogCalls, 0);
    assert.deepEqual(h.paid, { understand: 0, annotate: 0, explain: 0, prepare: 0, enqueue: 0 });
  } finally {
    h.cleanup();
  }
});

test('revoked AI grants keep recommendation feedback but forged explain stays inaccessible on old batches', async () => {
  const h = harness();
  try {
    h.store.put('access:grants', [{ userId, enabled: true }]);
    const oldBatch: Batch = {
      id: 'abc123abc123',
      userId,
      messageId: 50,
      articleIds: [1, 2],
      selected: [1],
      reasons: {},
      kind: 'recommendations',
      page: 0,
      createdAt: 1,
      notice: '',
      undo: [],
    };
    h.store.saveBatch(oldBatch);
    const reader = newReader(userId);
    reader.latestBatch = oldBatch.id;
    h.store.saveReader(reader);
    await h.dispatch(message('/deny 200', ownerId));
    const denied = callback(oldBatch, 'explain');
    assert.equal(h.service.accepts(denied), false);
    const before = h.calls.length;
    await h.dispatch(denied);
    assert.equal(h.calls.length, before);
    assert.equal(h.service.accepts(callback(oldBatch, 'save')), true);
    await h.dispatch(callback(oldBatch, 'save'));
    assert.equal(h.store.reader(userId)?.feedback[1]?.saved, true);
    await h.dispatch(callback(oldBatch, 'saved'));
    const saved = h.latest();
    await h.dispatch(callback(saved, 'select:1'));
    assert.equal(actions(h.lastMessage()).includes('explain'), false);
    assert.equal(h.service.accepts(callback(saved, 'explain')), false);
    await h.dispatch(callback(saved, 'explain'));
    assert.equal(h.store.reader(userId)?.focusedArticle, null);
    assert.deepEqual(h.paid, { understand: 0, annotate: 0, explain: 0, prepare: 0, enqueue: 0 });
  } finally {
    h.cleanup();
  }
});

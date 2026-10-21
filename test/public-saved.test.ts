import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { type Publication, readyPublication } from '../src/domain.js';
import {
  newReader,
  type Batch,
  type ReadingArticle,
  type ReadingCommand,
} from '../src/recommendations/model.js';
import {
  ReadingService,
  type ReadingTransport,
  type ReadingUpdate,
} from '../src/recommendations/service.js';
import { ReadingStore } from '../src/recommendations/store.js';
import { SqlitePublicationRepository } from '../src/storage/sqlite-publication-repository.js';
import { draft } from './fixtures.js';

const userId = 200;
function message(text: string, id = userId): ReadingUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      from: { id, is_bot: false },
      chat: { id, type: 'private' },
      text,
    },
  };
}
function callback(batch: Batch, action: string, id = userId): ReadingUpdate {
  assert.ok(batch.messageId);
  return {
    update_id: 2,
    callback_query: {
      id: `callback-${action}`,
      from: { id, is_bot: false },
      data: `r:${batch.id}:${action}`,
      message: { message_id: batch.messageId, chat: { id, type: 'private' } },
    },
  };
}
function harness(saved = 0) {
  const directory = mkdtempSync(join(process.cwd(), 'public-saved-test-'));
  const store = new ReadingStore(directory);
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const forbidden = async (): Promise<never> => {
    throw new Error('Public saved access must not invoke AI or refresh the catalog');
  };
  let messageId = 20;
  const transport: ReadingTransport = {
    call: async (method, payload) => {
      calls.push({ method, payload: { ...payload } });
      return { message_id: ++messageId };
    },
  };
  const service = new ReadingService(
    100,
    store,
    transport,
    { refresh: forbidden },
    { annotate: forbidden, understand: forbidden, explain: forbidden },
    () => 1000,
    { prepare: forbidden, enqueue: forbidden },
  );
  if (saved) {
    const reader = newReader(userId);
    for (let id = 1; id <= saved; id++) {
      const article: ReadingArticle = {
        id,
        title: `文章 ${id}`,
        originalTitle: `Article ${id}`,
        url: `https://example.com/${id}`,
        summaryUrl: null,
        description: `正文摘要 ${id}`,
        topics: ['架构'],
        score: 50,
        time: 1600000000,
        minutes: 5,
        evidence: 'fulltext',
      };
      store.saveArticle(article);
      reader.feedback[id] = { saved: true, opinion: 0, revision: 1, savedAt: id };
    }
    store.saveReader(reader);
  }
  return {
    directory,
    service,
    store,
    transport,
    calls,
    latest() {
      const reader = store.reader(userId);
      assert.ok(reader?.latestBatch);
      const batch = store.batch(reader.latestBatch);
      assert.ok(batch?.messageId);
      return batch;
    },
    cleanup() {
      store.close();
      rmSync(directory, { recursive: true });
    },
  };
}
function actions(payload: Record<string, unknown>): string[] {
  const keyboard = payload.reply_markup as {
    inline_keyboard: { text: string; callback_data: string }[][];
  };
  return keyboard.inline_keyboard.flat().map((button) => button.callback_data.split(':')[2] ?? '');
}

test('ungranted private readers can discover and view saved articles without model or catalog access', async () => {
  const h = harness();
  try {
    for (const text of ['/start', '/start@digestbot saved', '/help', '帮助']) {
      assert.equal(h.service.accepts(message(text)), true, text);
      await h.service.handle(message(text));
      assert.match(String(h.calls.at(-1)?.payload.text), /频道|收藏/);
      assert.doesNotMatch(String(h.calls.at(-1)?.payload.text), /账号已绑定|获取 5 篇/);
    }
    for (const text of ['/saved', '/saved@digestbot', '我的收藏', '收藏夹']) {
      await h.service.handle(message(text));
      assert.match(String(h.calls.at(-1)?.payload.text), /还没有收藏/);
      assert.match(String(h.calls.at(-1)?.payload.text), /频道/);
      assert.doesNotMatch(String(h.calls.at(-1)?.payload.text), /先发送“推荐”/);
    }
    assert.equal(h.calls.length, 8);
    assert.equal(
      h.calls.every((call) => call.method === 'sendMessage'),
      true,
    );
    assert.equal(h.store.reader(userId)?.latestBatch ?? null, null);
    assert.equal(h.service.accessStatus().enabledReaders, 1);
  } finally {
    h.cleanup();
  }
});

test('channel feedback is acknowledged during an in-flight model request and survives its later article action', async () => {
  const h = harness(1);
  const publications = new SqlitePublicationRepository(h.directory);
  const channelId = '-100123456789';
  const publication: Publication = {
    ...readyPublication({ ...draft, story: { ...draft.story, id: 1 } }, 1),
    state: 'published',
    page: { path: 'feedback-concurrent', url: 'https://telegra.ph/feedback-concurrent' },
    messageId: 50,
    publishedAt: 1,
  };
  publications.savePublication(publication);
  let release = () => {};
  let started = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const forbidden = async (): Promise<never> => {
    throw new Error('No recommendation or deep-reading request expected');
  };
  const service = new ReadingService(
    100,
    h.store,
    h.transport,
    { refresh: forbidden },
    {
      annotate: forbidden,
      explain: forbidden,
      understand: async () => {
        started();
        await blocked;
        return { action: 'like', selection: [1], interests: [], reply: '喜欢这篇' };
      },
    },
    () => 1000,
    undefined,
    undefined,
    { chatId: channelId, publications },
  );
  let work: Promise<void> | undefined;
  try {
    h.store.put('access:grants', [{ userId, enabled: true }]);
    await service.handle(message('/saved'));
    work = service.handle(message('这篇很好，多推荐类似的'));
    await entered;
    const click: ReadingUpdate = {
      update_id: 3,
      callback_query: {
        id: 'concurrent-save',
        from: { id: userId, is_bot: false },
        data: 'd:save:1',
        message: { message_id: 50, chat: { id: Number(channelId), type: 'channel' } },
      },
    };
    assert.equal(service.isImmediate(click), true);
    const handled = service.handle(click);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.store.reader(userId)?.feedback[1]?.saved, false);
    assert.equal(
      h.calls.some((call) => call.payload.callback_query_id === 'concurrent-save'),
      true,
    );
    await handled;
    release();
    await work;
    assert.deepEqual(h.store.reader(userId)?.feedback[1], {
      saved: false,
      opinion: 1,
      revision: 3,
      savedAt: 1,
    });
    assert.deepEqual(
      h.store.reader(userId)?.history.map((entry) => entry.content),
      ['这篇很好，多推荐类似的', '喜欢这篇'],
    );
  } finally {
    release();
    await work;
    publications.close();
    h.cleanup();
  }
});

test('public saved lists support pagination, removal and undo without AI calls or AI buttons', async () => {
  const h = harness(7);
  try {
    await h.service.handle(message('/saved'));
    let batch = h.latest();
    assert.deepEqual(batch.articleIds, [7, 6, 5, 4, 3]);
    assert.deepEqual(actions(h.calls.at(-1)?.payload ?? {}), [
      'select',
      'select',
      'select',
      'select',
      'select',
      'next',
    ]);
    await h.service.handle(callback(batch, 'next'));
    batch = h.latest();
    assert.equal(batch.page, 1);
    assert.deepEqual(batch.articleIds, [2, 1]);
    await h.service.handle(callback(batch, 'select:1'));
    batch = h.latest();
    assert.deepEqual(batch.selected, [2]);
    assert.deepEqual(actions(h.calls.at(-1)?.payload ?? {}), [
      'select',
      'select',
      'unsave',
      'clear',
    ]);
    await h.service.handle(callback(batch, 'unsave'));
    assert.equal(h.store.reader(userId)?.feedback[2]?.saved, false);
    assert.equal(h.store.reader(userId)?.feedback[1]?.saved, true);
    assert.equal(actions(h.calls.at(-1)?.payload ?? {}).includes('undo'), true);
    await h.service.handle(callback(batch, 'undo'));
    assert.equal(h.store.reader(userId)?.feedback[2]?.saved, true);
    await h.service.handle(callback(batch, 'prev'));
    assert.equal(h.latest().page, 0);
    assert.deepEqual(h.latest().articleIds, [7, 6, 5, 4, 3]);
    assert.equal(h.store.reader(100), null);
  } finally {
    h.cleanup();
  }
});

test('public access rejects model/admin actions, foreign batches and private identity mismatches', async () => {
  const h = harness(2);
  try {
    await h.service.handle(message('/saved'));
    const batch = h.latest();
    const before = h.calls.length;
    for (const text of [
      '推荐',
      '/recommend',
      '/preferences',
      '我喜欢数据库',
      '/users',
      '/status',
      '/allow 200',
    ]) {
      assert.equal(h.service.accepts(message(text)), false, text);
      await h.service.handle(message(text));
    }
    for (const action of ['more', 'like', 'less', 'explain', 'preferences', 'save']) {
      const update = callback(batch, action);
      assert.equal(h.service.accepts(update), false, action);
      await h.service.handle(update);
    }
    for (const action of ['select:1', 'unsave', 'undo', 'next']) {
      await h.service.handle(callback(batch, action, 300));
      const copied = callback(batch, action);
      assert.ok(copied.callback_query?.message);
      copied.callback_query.message.message_id += 1;
      await h.service.handle(copied);
    }
    const admin = callback(batch, 'ignored');
    assert.ok(admin.callback_query);
    admin.callback_query.data = 'ops:grant:200';
    await h.service.handle(admin);
    const group = message('/saved');
    assert.ok(group.message);
    group.message.chat = { id: -100, type: 'supergroup' };
    await h.service.handle(group);
    assert.equal(h.calls.length, before);
    assert.deepEqual(h.store.batch(batch.id)?.selected, []);
    assert.equal(h.store.reader(300), null);
  } finally {
    h.cleanup();
  }
});

test('revoking AI access preserves public saves but rejects callbacks on old recommendation batches', async () => {
  const h = harness(2);
  try {
    h.store.put('access:grants', [{ userId, enabled: true }]);
    await h.service.handle(message('/saved'));
    const batch = h.latest();
    assert.equal(actions(h.calls.at(-1)?.payload ?? {}).includes('more'), true);
    await h.service.handle(message('/deny 200', 100));
    await h.service.handle(callback(batch, 'select:1'));
    await h.service.handle(callback(batch, 'unsave'));
    assert.equal(h.store.reader(userId)?.feedback[2]?.saved, false);
    assert.equal(actions(h.calls.at(-1)?.payload ?? {}).includes('more'), false);
    await h.service.handle(callback(batch, 'undo'));
    assert.equal(h.store.reader(userId)?.feedback[2]?.saved, true);
    const oldRecommendations = { ...batch, id: 'abc123abc123', kind: 'recommendations' as const };
    h.store.saveBatch(oldRecommendations);
    const before = h.calls.length;
    await h.service.handle(callback(oldRecommendations, 'select:1'));
    await h.service.handle(callback(oldRecommendations, 'save'));
    assert.equal(h.calls.length, before);
    await h.service.handle(message('/saved'));
    assert.deepEqual(h.latest().articleIds, [2, 1]);
  } finally {
    h.cleanup();
  }
});

test('revocation during model interpretation prevents later model, catalog and profile effects', async () => {
  for (const action of ['recommend', 'explain', 'preferences'] as const) {
    const h = harness(1);
    let release = () => {};
    let entered = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let modelCalls = 0;
    let catalogCalls = 0;
    const command: ReadingCommand = {
      action,
      selection: [1],
      interests: [{ name: '数据库', query: 'database', weight: 2 }],
      reply: '操作完成',
    };
    const service = new ReadingService(
      100,
      h.store,
      h.transport,
      {
        refresh: async () => {
          catalogCalls++;
        },
      },
      {
        annotate: async (articles) => articles,
        explain: async () => {
          modelCalls++;
          return '第二次模型回答';
        },
        understand: async () => {
          modelCalls++;
          entered();
          await gate;
          return command;
        },
      },
    );
    let pending: Promise<void> | undefined;
    try {
      h.store.put('access:grants', [{ userId, enabled: true }]);
      await service.handle(message('/saved'));
      const before = h.store.reader(userId);
      pending = service.handle(message('请帮我处理这篇'));
      await started;
      await service.handle(message('/deny 200', 100));
      const callCount = h.calls.length;
      release();
      await pending;
      assert.equal(modelCalls, 1, action);
      assert.equal(catalogCalls, 0, action);
      assert.equal(h.calls.length, callCount, action);
      assert.deepEqual(h.store.reader(userId), before, action);
    } finally {
      release();
      await pending?.catch(() => {});
      h.cleanup();
    }
  }
});

test('revocation during callback acknowledgement prevents deep reading and model actions', async () => {
  const h = harness(1);
  let release = () => {};
  let entered = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let deepCalls = 0;
  const service = new ReadingService(
    100,
    h.store,
    {
      call: async (method, payload) => {
        if (method === 'answerCallbackQuery') {
          entered();
          await gate;
        }
        return h.transport.call(method, payload);
      },
    },
    { refresh: async () => {} },
    {
      annotate: async (articles) => articles,
      understand: async () => {
        throw new Error('Unexpected model');
      },
      explain: async () => '',
    },
    () => 1000,
    {
      prepare: async (article) => {
        deepCalls++;
        return article;
      },
    },
  );
  let pending: Promise<void> | undefined;
  try {
    h.store.put('access:grants', [{ userId, enabled: true }]);
    await service.handle(message('/saved'));
    const batch = h.latest();
    batch.selected = [1];
    h.store.saveBatch(batch);
    pending = service.handle(callback(batch, 'explain'));
    await started;
    await service.handle(message('/deny 200', 100));
    release();
    await pending;
    assert.equal(deepCalls, 0);
    assert.equal(h.store.reader(userId)?.focusedArticle, null);
    assert.equal(
      h.calls.filter((call) => call.method === 'sendMessage' && call.payload.chat_id === userId)
        .length,
      1,
    );
  } finally {
    release();
    await pending?.catch(() => {});
    h.cleanup();
  }
});

test('public saved failures receive deterministic recovery without opening restricted paths', async () => {
  const h = harness(1);
  try {
    await h.service.handle(message('/saved'));
    const batch = h.latest();
    for (const update of [message('/saved'), callback(batch, 'next')]) {
      await h.service.reportFailure(update);
      assert.equal(h.calls.at(-1)?.method, 'sendMessage');
      assert.equal(h.calls.at(-1)?.payload.chat_id, userId);
      assert.match(String(h.calls.at(-1)?.payload.text), /发送 \/saved 核对收藏/);
      assert.doesNotMatch(String(h.calls.at(-1)?.payload.text), /发送“推荐”/);
    }
    const count = h.calls.length;
    await h.service.reportFailure(message('推荐'));
    await h.service.reportFailure(callback(batch, 'explain'));
    await h.service.reportFailure(callback(batch, 'next', 300));
    await h.service.reportFailure(message('/start'));
    assert.equal(h.calls.length, count);
  } finally {
    h.cleanup();
  }
});

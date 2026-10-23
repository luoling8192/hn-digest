import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { type Publication, readyPublication } from '../src/domain.js';
import type { ReadingAssistant } from '../src/recommendations/assistant.js';
import {
  bindChannelFeedbackPreview,
  ChannelFeedback,
} from '../src/recommendations/channel-feedback.js';
import { newReader } from '../src/recommendations/model.js';
import { recommend } from '../src/recommendations/ranking.js';
import {
  ReadingService,
  type ReadingTransport,
  type ReadingUpdate,
} from '../src/recommendations/service.js';
import { ReadingStore } from '../src/recommendations/store.js';
import { SqlitePublicationRepository } from '../src/storage/sqlite-publication-repository.js';
import { draft } from './fixtures.js';

const owner = 100;
const channelId = '-1004304069991';
const messageId = 3;
const storyId = draft.story.id;

function callback(id: string, action = 'save', userId = owner): ReadingUpdate {
  return {
    update_id: 1,
    callback_query: {
      id,
      from: { id: userId, is_bot: false },
      data: `d:${action}:${storyId}`,
      message: {
        message_id: messageId,
        chat: { id: Number(channelId), type: 'channel' },
      },
    },
  };
}

function message(text: string, userId = owner): ReadingUpdate {
  return {
    update_id: 2,
    message: {
      message_id: 20,
      chat: { id: userId, type: 'private' },
      from: { id: userId, is_bot: false },
      text,
    },
  };
}

function harness() {
  const directory = mkdtempSync(join(process.cwd(), 'data-test-channel-'));
  const store = new ReadingStore(directory);
  const publications = new SqlitePublicationRepository(directory);
  const publication: Publication = {
    ...readyPublication({ ...draft, story: { ...draft.story, score: 120 } }, 1),
    state: 'published',
    page: { path: 'channel-test', url: 'https://telegra.ph/channel-test' },
    messageId,
    publishedAt: 1,
  };
  publications.savePublication(publication);
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const transport: ReadingTransport = {
    call: async (method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      return { message_id: 30 + calls.length };
    },
  };
  const assistant: ReadingAssistant = {
    annotate: async () => {
      throw new Error('Channel feedback must not invoke the model');
    },
    understand: async () => {
      throw new Error('Channel feedback must not invoke the model');
    },
    explain: async () => {
      throw new Error('Channel feedback must not invoke the model');
    },
  };
  let time = 1000;
  const makeService = (readingStore = store) =>
    new ReadingService(
      owner,
      readingStore,
      transport,
      {
        refresh: async () => {
          throw new Error('Direct channel feedback must not refresh the catalog');
        },
      },
      assistant,
      () => time,
      undefined,
      undefined,
      { chatId: channelId, publications },
    );
  const service = makeService();
  return {
    directory,
    store,
    publications,
    publication,
    transport,
    calls,
    service,
    makeService,
    advance: () => {
      time += 1000;
    },
    setTime: (value: number) => {
      time = value;
    },
    cleanup: () => {
      publications.close();
      store.close();
      rmSync(directory, { recursive: true });
    },
  };
}

test('channel likes and saves toggle independently and low-score publications appear in private saved lists', async () => {
  const h = harness();
  try {
    assert.equal(h.service.accepts(callback('save-1')), true);
    await h.service.handle(callback('save-1'));
    assert.deepEqual(h.store.reader(owner)?.feedback[storyId], {
      saved: true,
      opinion: 0,
      revision: 1,
      savedAt: 1000,
    });
    assert.equal(h.store.article(storyId)?.score, 120);
    assert.equal(h.store.article(storyId)?.summaryUrl, h.publication.page?.url);
    assert.deepEqual(h.store.source(storyId), draft.article);
    await h.service.handle(callback('like-1', 'like'));
    assert.deepEqual(h.store.reader(owner)?.feedback[storyId], {
      saved: true,
      opinion: 1,
      revision: 2,
      savedAt: 1000,
    });
    await h.service.handle(callback('like-2', 'like'));
    assert.equal(h.store.reader(owner)?.feedback[storyId]?.opinion, 0);
    await h.service.handle(callback('save-2'));
    assert.equal(h.store.reader(owner)?.feedback[storyId]?.saved, false);
    h.advance();
    await h.service.handle(callback('save-3'));
    assert.equal(h.store.reader(owner)?.feedback[storyId]?.savedAt, 2000);
    assert.equal(h.store.reader(owner)?.feedback[storyId]?.revision, 5);
    assert.ok(h.calls.every((call) => call.method === 'answerCallbackQuery'));
    await h.service.handle(message('/saved'));
    assert.equal(h.calls.at(-1)?.method, 'sendMessage');
    assert.equal(h.calls.at(-1)?.payload.chat_id, owner);
    assert.match(String(h.calls.at(-1)?.payload.text), /channel-test/);
    const reader = h.store.reader(owner);
    assert.ok(reader?.latestBatch);
    assert.deepEqual(h.store.batch(reader.latestBatch)?.articleIds, [storyId]);
  } finally {
    h.cleanup();
  }
});

test('duplicate channel callback receipts survive reopening and replay the original toast without toggling', async () => {
  const h = harness();
  try {
    const update = callback('persisted-callback');
    await h.service.handle(update);
    const originalAnswer = h.calls.at(-1);
    await h.service.handle(callback('different-click'));
    assert.equal(h.store.reader(owner)?.feedback[storyId]?.saved, false);
    const reopened = new ReadingStore(h.directory);
    try {
      await h.makeService(reopened).handle(update);
      assert.deepEqual(h.calls.at(-1), originalAnswer);
      assert.deepEqual(reopened.reader(owner)?.feedback[storyId], {
        saved: false,
        opinion: 0,
        revision: 2,
        savedAt: 1000,
      });
      assert.equal(reopened.article(storyId)?.summaryUrl, h.publication.page?.url);
    } finally {
      reopened.close();
    }
  } finally {
    h.cleanup();
  }
});

test('saving a source-unavailable publication keeps its link accessible without making it recommendable', async () => {
  const h = harness();
  try {
    h.publications.savePublication({
      ...h.publication,
      draft: {
        ...draft,
        story: { ...draft.story, score: 400 },
        article: { source: 'unavailable', text: '', readingMinutes: null },
      },
    });
    await h.service.handle(callback('unavailable-save'));
    assert.equal(h.store.reader(owner)?.feedback[storyId]?.saved, true);
    assert.equal(h.store.article(storyId)?.evidence, 'title');
    assert.deepEqual(recommend(newReader(200), h.store.articles()), []);
    await h.service.handle(message('/saved'));
    assert.match(String(h.calls.at(-1)?.payload.text), /channel-test/);
  } finally {
    h.cleanup();
  }
});

test('public channel feedback isolates readers and never grants model or administrative access', async () => {
  const h = harness();
  try {
    const stranger = callback('stranger', 'save', 300);
    assert.equal(h.service.accepts(stranger), true);
    await h.service.handle(stranger);
    assert.equal(h.calls.at(-1)?.method, 'answerCallbackQuery');
    assert.match(String(h.calls.at(-1)?.payload.text), /已收藏/);
    assert.equal(h.store.reader(300)?.feedback[storyId]?.saved, true);
    assert.equal(h.store.article(storyId)?.summaryUrl, h.publication.page?.url);
    assert.equal(h.service.accepts(message('/saved', 300)), true);
    assert.equal(h.service.accepts(message('/recommend', 300)), true);
    assert.equal(h.service.accepts(message('解释这篇文章', 300)), false);
    await h.service.handle(message('/allow 200'));
    await h.service.handle(callback('owner-save'));
    await h.service.handle(callback('guest-like', 'like', 200));
    assert.equal(h.store.reader(owner)?.feedback[storyId]?.saved, true);
    assert.equal(h.store.reader(owner)?.feedback[storyId]?.opinion, 0);
    assert.equal(h.store.reader(200)?.feedback[storyId]?.saved, false);
    assert.equal(h.store.reader(200)?.feedback[storyId]?.opinion, 1);
    const callsBeforeAdmin = h.calls.length;
    await h.service.handle(message('/allow 300', 200));
    await h.service.handle(message('/status', 200));
    const admin = callback('forged-admin', 'save', 200);
    assert.ok(admin.callback_query);
    admin.callback_query.data = 'ops:grant:300';
    await h.service.handle(admin);
    assert.equal(h.calls.length, callsBeforeAdmin);
    assert.equal(h.service.accepts(message('/saved', 300)), true);
    await h.service.handle(message('/deny 200'));
    await h.service.handle(callback('revoked-save', 'save', 200));
    assert.equal(h.store.reader(200)?.feedback[storyId]?.saved, true);
    assert.equal(h.service.accepts(message('/recommend', 200)), true);
    assert.equal(h.service.accepts(message('解释这篇文章', 200)), false);
  } finally {
    h.cleanup();
  }
});

test('channel callbacks require the configured channel, a published story and its exact original message', async () => {
  const h = harness();
  try {
    const variants: ReadingUpdate[] = [];
    for (const chat of [
      { id: owner, type: 'private' },
      { id: Number(channelId), type: 'supergroup' },
      { id: -100999, type: 'channel' },
    ]) {
      const update = callback(`chat-${chat.type}-${chat.id}`);
      assert.ok(update.callback_query?.message);
      update.callback_query.message.chat = chat;
      variants.push(update);
    }
    const wrongMessage = callback('wrong-message');
    assert.ok(wrongMessage.callback_query?.message);
    wrongMessage.callback_query.message.message_id += 1;
    variants.push(wrongMessage);
    for (const data of ['d:save:999', 'd:save:0', 'd:save:9007199254740992', 'd:less:123']) {
      const update = callback(data);
      assert.ok(update.callback_query);
      update.callback_query.data = data;
      variants.push(update);
    }
    const bot = callback('bot');
    assert.ok(bot.callback_query);
    bot.callback_query.from.is_bot = true;
    variants.push(bot);
    for (const update of variants) {
      assert.equal(h.service.accepts(update), false);
      await h.service.handle(update);
    }
    assert.equal(h.store.reader(owner), null);
    assert.equal(h.store.article(storyId), null);
    assert.ok(h.calls.every((call) => call.method === 'answerCallbackQuery'));
    assert.equal(h.calls.length, 0);
    h.publications.savePublication({ ...h.publication, state: 'ready' });
    assert.equal(h.service.accepts(callback('unpublished')), false);
    await h.service.handle(callback('unpublished'));
    assert.equal(h.store.reader(owner), null);
  } finally {
    h.cleanup();
  }
});

test('channel feedback rolls back article, reader and receipt together when persistence validation fails', async () => {
  const h = harness();
  try {
    h.setTime(Number.NaN);
    await assert.rejects(h.service.handle(callback('atomic-save')), /Invalid input/);
    assert.equal(h.store.reader(owner), null);
    assert.equal(h.store.article(storyId), null);
    assert.equal(h.store.source(storyId), null);
    assert.equal(h.calls.length, 0);
    h.setTime(3000);
    await h.service.handle(callback('atomic-save'));
    assert.deepEqual(h.store.reader(owner)?.feedback[storyId], {
      saved: true,
      opinion: 0,
      revision: 1,
      savedAt: 3000,
    });
    await h.service.handle(callback('atomic-save'));
    assert.equal(h.store.reader(owner)?.feedback[storyId]?.revision, 1);
  } finally {
    h.cleanup();
  }
});

test('a reused callback ID cannot affect a different reader and model-access revocation preserves public feedback', async () => {
  const h = harness();
  try {
    await h.service.handle(message('/allow 200'));
    await h.service.handle(callback('same-id'));
    await assert.rejects(
      h.service.handle(callback('same-id', 'save', 200)),
      /callback identity mismatch/,
    );
    assert.equal(h.store.reader(200), null);
    assert.equal(h.store.reader(owner)?.feedback[storyId]?.revision, 1);
    await h.service.handle(callback('guest-replay', 'like', 200));
    const before = h.store.reader(200);
    await h.service.handle(message('/deny 200'));
    await h.service.handle(callback('guest-replay', 'like', 200));
    assert.equal(h.calls.at(-1)?.payload.show_alert, undefined);
    assert.match(String(h.calls.at(-1)?.payload.text), /已喜欢/);
    assert.deepEqual(h.store.reader(200), before);
    assert.equal(h.service.accepts(message('/recommend', 200)), true);
    assert.equal(h.service.accepts(message('解释这篇文章', 200)), false);
  } finally {
    h.cleanup();
  }
});

test('channel failure reporting answers the callback without unsolicited private messages', async () => {
  const h = harness();
  try {
    await h.service.reportFailure(callback('failed-callback'));
    assert.deepEqual(
      h.calls.map((call) => call.method),
      ['answerCallbackQuery'],
    );
    assert.equal(h.calls[0]?.payload.callback_query_id, 'failed-callback');
    assert.equal(h.calls[0]?.payload.show_alert, true);
    assert.match(String(h.calls[0]?.payload.text), /状态可能已保存/);
    assert.equal(h.store.reader(owner), null);
  } finally {
    h.cleanup();
  }
});

test('a failed callback acknowledgement leaves the committed save intact and replay does not toggle it', async () => {
  const h = harness();
  try {
    const send = h.transport.call;
    let failAnswer = true;
    h.transport.call = async (method, payload, signal) => {
      if (method === 'answerCallbackQuery' && failAnswer) {
        failAnswer = false;
        throw new Error('Telegram acknowledgement failed');
      }
      return send(method, payload, signal);
    };
    const update = callback('failed-answer');
    await assert.rejects(h.service.handle(update), /acknowledgement failed/);
    assert.equal(h.store.reader(owner)?.feedback[storyId]?.saved, true);
    assert.equal(h.store.reader(owner)?.feedback[storyId]?.revision, 1);
    await h.service.reportFailure(update);
    assert.match(String(h.calls.at(-1)?.payload.text), /再次点击会切换状态/);
    await h.service.handle(update);
    assert.equal(h.store.reader(owner)?.feedback[storyId]?.saved, true);
    assert.equal(h.store.reader(owner)?.feedback[storyId]?.revision, 1);
    assert.match(String(h.calls.at(-1)?.payload.text), /已收藏/);
    assert.ok(h.calls.every((call) => call.method === 'answerCallbackQuery'));
  } finally {
    h.cleanup();
  }
});

test('preview feedback requires an explicit message binding and keeps canonical publication IDs intact across restart', async () => {
  const h = harness();
  const previewChatId = '-100999888777';
  const options = { chatId: channelId, previewChatId, publications: h.publications };
  const update = callback('preview-save', 'save', 900);
  assert.ok(update.callback_query?.message);
  update.callback_query.message.chat.id = Number(previewChatId);
  update.callback_query.message.message_id = 77;
  try {
    const handler = new ChannelFeedback(options, h.store, h.transport, () => 1000);
    assert.equal(handler.accepts(update), false);
    bindChannelFeedbackPreview(options, h.store, storyId, 77);
    assert.equal(handler.accepts(update), true);
    const reopened = new ReadingStore(h.directory);
    try {
      const resumed = new ChannelFeedback(options, reopened, h.transport, () => 1000);
      assert.equal(resumed.accepts(update), true);
      await resumed.handle(update);
      assert.equal(reopened.reader(900)?.feedback[storyId]?.saved, true);
      assert.equal(reopened.article(storyId)?.summaryUrl, h.publication.page?.url);
      assert.equal(h.publications.getPublication(storyId)?.messageId, messageId);
      update.callback_query.message.message_id = 78;
      assert.equal(resumed.accepts(update), false);
    } finally {
      reopened.close();
    }
    assert.throws(() => bindChannelFeedbackPreview(options, h.store, 999, 80), /not found/i);
    assert.throws(
      () =>
        bindChannelFeedbackPreview({ ...options, previewChatId: channelId }, h.store, storyId, 80),
      /separate preview channel/i,
    );
    h.publications.savePublication({ ...h.publication, state: 'ready' });
    assert.throws(
      () => bindChannelFeedbackPreview(options, h.store, storyId, 80),
      /published story/i,
    );
  } finally {
    h.cleanup();
  }
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readyPublication, type Publication } from '../src/domain.js';
import { renderTelegramMessage } from '../src/presentation.js';
import { bindChannelFeedbackPreview } from '../src/recommendations/channel-feedback.js';
import type { Batch } from '../src/recommendations/model.js';
import {
  ReadingService,
  type ReadingTransport,
  type ReadingUpdate,
} from '../src/recommendations/service.js';
import { ReadingStore } from '../src/recommendations/store.js';
import { SqlitePublicationRepository } from '../src/storage/sqlite-publication-repository.js';
import { draft } from './fixtures.js';

const ownerId = 100;
const userId = 200;
const storyId = draft.story.id;
const channelId = '-100123456789';
const previewChatId = '-100987654321';
const canonicalMessageId = 42;
const previewMessageId = 77;
let updateId = 0;

function channelClick(
  action: 'like' | 'save',
  id = userId,
  callbackId = `counts-${++updateId}`,
  chatId = channelId,
  messageId = canonicalMessageId,
  targetStoryId = storyId,
): ReadingUpdate {
  return {
    update_id: ++updateId,
    callback_query: {
      id: callbackId,
      from: { id, is_bot: false },
      data: `d:${action}:${targetStoryId}`,
      message: { message_id: messageId, chat: { id: Number(chatId), type: 'channel' } },
    },
  };
}

function privateMessage(text: string): ReadingUpdate {
  return {
    update_id: ++updateId,
    message: {
      message_id: updateId,
      from: { id: userId, is_bot: false },
      chat: { id: userId, type: 'private' },
      text,
    },
  };
}

function privateClick(batch: Batch, action: string): ReadingUpdate {
  assert.ok(batch.messageId);
  return {
    update_id: ++updateId,
    callback_query: {
      id: `private-counts-${updateId}`,
      from: { id: userId, is_bot: false },
      data: `r:${batch.id}:${action}`,
      message: { message_id: batch.messageId, chat: { id: userId, type: 'private' } },
    },
  };
}

function assertCounts(
  payload: object,
  likes: number,
  saves: number,
  targetStoryId = storyId,
): void {
  const { reply_markup: markup } = payload as {
    reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] };
  };
  const buttons = markup.inline_keyboard.flat();
  for (const [action, expected] of [
    ['like', likes],
    ['save', saves],
  ] as const) {
    const button = buttons.find(
      (candidate) => candidate.callback_data === `d:${action}:${targetStoryId}`,
    );
    assert.ok(button, `Missing stable ${action} callback`);
    assert.deepEqual(button.text.match(/\d+/g), [String(expected)], `${action} aggregate count`);
  }
}

function harness() {
  const directory = mkdtempSync(join(process.cwd(), 'channel-counts-test-'));
  let store = new ReadingStore(directory);
  const publications = new SqlitePublicationRepository(directory);
  const publication: Publication = {
    ...readyPublication(draft, 1),
    state: 'published',
    page: { path: 'counts-test', url: 'https://telegra.ph/counts-test' },
    messageId: canonicalMessageId,
    publishedAt: 1,
  };
  publications.savePublication(publication);
  const options = { chatId: channelId, previewChatId, publications };
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const delivered = new Map<string, object>();
  let now = 1000;
  let sentId = 300;
  let hook: ((method: string, payload: object, signal?: AbortSignal) => Promise<void>) | undefined;
  const forbidden = async (): Promise<never> => {
    throw new Error('Feedback counters must not invoke AI, catalog refresh or deep reading');
  };
  const transport: ReadingTransport = {
    call: async (method, payload, signal) => {
      const recorded = structuredClone(payload) as Record<string, unknown>;
      calls.push({ method, payload: recorded });
      if (hook) await hook(method, payload, signal);
      if (method === 'editMessageReplyMarkup')
        delivered.set(`${recorded.chat_id}:${recorded.message_id}`, recorded);
      return { message_id: ++sentId };
    },
  };
  const createService = () =>
    new ReadingService(
      ownerId,
      store,
      transport,
      { refresh: forbidden },
      { understand: forbidden, annotate: forbidden, explain: forbidden },
      () => now,
      { prepare: forbidden, enqueue: forbidden },
      undefined,
      options,
    );
  let service = createService();
  return {
    calls,
    delivered,
    publications,
    publication,
    get store() {
      return store;
    },
    get service() {
      return service;
    },
    bindPreview() {
      bindChannelFeedbackPreview(options, store, storyId, previewMessageId);
    },
    setHook(value: typeof hook) {
      hook = value;
    },
    async dispatch(update: ReadingUpdate) {
      now += 2000;
      await service.handle(update);
    },
    advance(milliseconds: number) {
      now += milliseconds;
    },
    latest(): Batch {
      const reader = store.reader(userId);
      assert.ok(reader?.latestBatch);
      const batch = store.batch(reader.latestBatch);
      assert.ok(batch?.messageId);
      return batch;
    },
    edits() {
      return calls.filter((call) => call.method === 'editMessageReplyMarkup');
    },
    assertDelivered(likes: number, saves: number, preview = false) {
      const canonical = delivered.get(`${channelId}:${canonicalMessageId}`);
      assert.ok(canonical, 'Canonical message counters were not edited');
      assertCounts(canonical, likes, saves);
      if (preview) {
        const dev = delivered.get(`${previewChatId}:${previewMessageId}`);
        assert.ok(dev, 'Bound preview counters were not edited');
        assertCounts(dev, likes, saves);
      }
    },
    restart() {
      store.close();
      store = new ReadingStore(directory);
      service = createService();
    },
    cleanup() {
      publications.close();
      store.close();
      rmSync(directory, { recursive: true });
    },
  };
}

test('new channel feedback keyboards display zero counts with stable like and save callbacks', () => {
  assertCounts(renderTelegramMessage(draft, 'https://telegra.ph/counts-test', true), 0, 0);
});

test('channel totals count distinct users and reflect independent toggles without replaying a callback', async () => {
  const h = harness();
  try {
    const original = channelClick('like');
    await h.dispatch(original);
    await h.dispatch(channelClick('save'));
    await h.dispatch(channelClick('like', 300));
    await h.dispatch(channelClick('save', 300));
    await h.dispatch(original);
    assert.deepEqual(h.store.feedbackCounts(storyId), { likes: 2, saves: 2 });
    assert.equal(h.store.reader(userId)?.feedback[storyId]?.revision, 2);
    assert.equal(
      h.edits().length,
      0,
      'Channel click should acknowledge before background count sync',
    );
    await h.service.syncFeedback();
    h.assertDelivered(2, 2);
    const delivered = h.edits().length;
    await h.dispatch(original);
    await h.service.syncFeedback();
    assert.equal(h.edits().length, delivered, 'Replay must not mark already-counted state dirty');
    await h.dispatch(channelClick('like'));
    await h.dispatch(channelClick('save', 300));
    await h.service.syncFeedback();
    h.assertDelivered(1, 1);
    assert.deepEqual(h.store.pendingFeedbackCounts(), []);
    assert.equal(
      h.calls.some((call) => call.method === 'sendMessage'),
      false,
    );
  } finally {
    h.cleanup();
  }
});

test('private save, removal, undo and negative opinion refresh both canonical and explicitly bound preview totals', async () => {
  const h = harness();
  try {
    h.bindPreview();
    await h.dispatch(channelClick('like'));
    await h.dispatch(channelClick('save'));
    await h.dispatch(privateMessage('/saved'));
    const batch = h.latest();
    await h.service.syncFeedback();
    h.assertDelivered(1, 1, true);

    await h.dispatch(privateClick(batch, 'select:1'));
    await h.dispatch(privateClick(batch, 'unsave'));
    await h.service.syncFeedback();
    h.assertDelivered(1, 0, true);
    await h.dispatch(privateClick(batch, 'undo'));
    await h.service.syncFeedback();
    h.assertDelivered(1, 1, true);
    await h.dispatch(privateClick(batch, 'select:1'));
    await h.dispatch(privateClick(batch, 'less'));
    await h.service.syncFeedback();
    h.assertDelivered(0, 1, true);
    await h.dispatch(privateClick(batch, 'select:1'));
    await h.dispatch(privateClick(batch, 'unsave'));
    await h.service.syncFeedback();
    h.assertDelivered(0, 0, true);
    await h.dispatch(privateClick(batch, 'select:1'));
    await h.dispatch(privateClick(batch, 'save'));
    await h.service.syncFeedback();
    h.assertDelivered(0, 1, true);
    assert.deepEqual(h.store.feedbackCounts(storyId), { likes: 0, saves: 1 });
    assert.equal(h.publications.getPublication(storyId)?.messageId, canonicalMessageId);
  } finally {
    h.cleanup();
  }
});

test('count synchronization never edits foreign or unbound preview messages or unpublished stories', async () => {
  const h = harness();
  try {
    h.bindPreview();
    await h.service.syncFeedback();
    const baseline = h.edits().length;
    for (const update of [
      channelClick('like', userId, 'unbound-dev', previewChatId, previewMessageId + 1),
      channelClick('save', userId, 'foreign-channel', '-100555555555', canonicalMessageId),
      channelClick('save', userId, 'wrong-canonical-message', channelId, canonicalMessageId + 1),
    ]) {
      assert.equal(h.service.accepts(update), false);
      await h.dispatch(update);
    }
    await h.service.syncFeedback();
    assert.equal(h.edits().length, baseline);
    h.store.put(`channel-preview:-100555555555:99`, { storyId });
    await h.dispatch(channelClick('like'));
    await h.service.syncFeedback();
    assert.equal(
      h
        .edits()
        .every(
          (call) =>
            (call.payload.chat_id === channelId &&
              call.payload.message_id === canonicalMessageId) ||
            (call.payload.chat_id === previewChatId &&
              call.payload.message_id === previewMessageId),
        ),
      true,
    );
    h.publications.savePublication({ ...h.publication, state: 'ready' });
    h.store.markFeedbackCounts(storyId);
    h.store.markFeedbackCounts(storyId + 1);
    const beforeDraftSync = h.edits().length;
    await h.service.syncFeedback();
    assert.equal(h.edits().length, beforeDraftSync);
  } finally {
    h.cleanup();
  }
});

test('a channel click while a count edit is awaiting Telegram cannot acknowledge away the newer totals', {
  timeout: 3000,
}, async () => {
  const h = harness();
  let release = () => {};
  let entered = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let pending: Promise<void> | undefined;
  try {
    h.bindPreview();
    await h.dispatch(channelClick('like'));
    let blockedOnce = false;
    h.setHook(async (method) => {
      if (method === 'editMessageReplyMarkup' && !blockedOnce) {
        blockedOnce = true;
        entered();
        await blocked;
      }
    });
    pending = h.service.syncFeedback();
    await started;
    await h.dispatch(channelClick('like', 300));
    assert.deepEqual(h.store.feedbackCounts(storyId), { likes: 2, saves: 0 });
    release();
    await pending;
    await h.service.syncFeedback();
    h.assertDelivered(2, 0, true);
    assert.deepEqual(h.store.pendingFeedbackCounts(), []);
    const count = h.edits().length;
    await h.service.syncFeedback();
    assert.equal(h.edits().length, count);
  } finally {
    release();
    await pending?.catch(() => {});
    h.cleanup();
  }
});

test('failed counter edits stay dirty across restart and retry without toggling reader state or repeating a completed sync', async () => {
  const h = harness();
  try {
    h.bindPreview();
    const update = channelClick('save');
    await h.dispatch(update);
    let failed = false;
    h.setHook(async (method, payload) => {
      if (
        method === 'editMessageReplyMarkup' &&
        !failed &&
        (payload as Record<string, unknown>).chat_id === previewChatId
      ) {
        failed = true;
        throw new Error('Telegram counter edit failed');
      }
    });
    await assert.rejects(h.service.syncFeedback(), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, 'Channel feedback counts sync failed');
      assert.equal(error.errors.length, 1);
      assert.ok(error.errors[0] instanceof Error);
      assert.equal(error.errors[0].message, 'Telegram counter edit failed');
      return true;
    });
    assert.equal(
      h.store.pendingFeedbackCounts().some((entry) => entry.storyId === storyId),
      true,
    );
    assert.deepEqual(h.store.feedbackCounts(storyId), { likes: 0, saves: 1 });
    const reader = h.store.reader(userId);
    h.restart();
    h.setHook(undefined);
    await h.service.syncFeedback();
    h.assertDelivered(0, 1, true);
    assert.deepEqual(h.store.reader(userId), reader);
    assert.deepEqual(h.store.pendingFeedbackCounts(), []);
    const completed = h.edits().length;
    await h.dispatch(update);
    await h.service.syncFeedback();
    await h.service.syncFeedback();
    assert.equal(h.edits().length, completed);
    assert.deepEqual(h.store.reader(userId), reader);
  } finally {
    h.cleanup();
  }
});

test('a failed article count edit does not block another article and only the failed article remains dirty during retry backoff', async () => {
  const h = harness();
  const secondStoryId = 456;
  const secondMessageId = canonicalMessageId + 1;
  try {
    h.publications.savePublication({
      ...readyPublication({ ...draft, story: { ...draft.story, id: secondStoryId } }, 1),
      state: 'published',
      page: { path: 'counts-second', url: 'https://telegra.ph/counts-second' },
      messageId: secondMessageId,
      publishedAt: 1,
    });
    await h.dispatch(channelClick('like'));
    await h.dispatch(
      channelClick('save', 300, 'second-article-save', channelId, secondMessageId, secondStoryId),
    );
    h.setHook(async (method, payload) => {
      if (
        method === 'editMessageReplyMarkup' &&
        (payload as Record<string, unknown>).message_id === canonicalMessageId
      )
        throw new Error('First article edit failed');
    });
    await assert.rejects(h.service.syncFeedback(), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 1);
      assert.ok(error.errors[0] instanceof Error);
      assert.equal(error.errors[0].message, 'First article edit failed');
      return true;
    });
    const delivered = h.delivered.get(`${channelId}:${secondMessageId}`);
    assert.ok(delivered, 'A failed article must not prevent delivery of another article count');
    assertCounts(delivered, 0, 1, secondStoryId);
    assert.deepEqual(
      h.store.pendingFeedbackCounts().map((entry) => entry.storyId),
      [storyId],
    );
    const attempted = h.edits().length;
    h.setHook(undefined);
    h.advance(29_999);
    await h.service.syncFeedback();
    assert.equal(
      h.edits().length,
      attempted,
      'Retry must respect its backoff without repeating successful articles',
    );
    h.advance(1);
    await h.service.syncFeedback();
    h.assertDelivered(1, 0);
    assert.deepEqual(h.store.pendingFeedbackCounts(), []);
    const completed = h.edits().length;
    await h.service.syncFeedback();
    assert.equal(h.edits().length, completed);
  } finally {
    h.cleanup();
  }
});

test('a rejected canonical count edit still updates its bound preview while keeping the article dirty', async () => {
  const h = harness();
  try {
    h.bindPreview();
    await h.dispatch(channelClick('save'));
    h.setHook(async (method, payload) => {
      if (
        method === 'editMessageReplyMarkup' &&
        (payload as Record<string, unknown>).chat_id === channelId
      ) {
        throw new Error('Canonical counter edit rejected');
      }
    });
    await assert.rejects(h.service.syncFeedback(), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 1);
      assert.ok(error.errors[0] instanceof Error);
      assert.equal(error.errors[0].message, 'Canonical counter edit rejected');
      return true;
    });
    const preview = h.delivered.get(`${previewChatId}:${previewMessageId}`);
    assert.ok(preview, 'A rejected canonical edit must not prevent a legitimate preview update');
    assertCounts(preview, 0, 1);
    assert.deepEqual(
      h.store.pendingFeedbackCounts().map((entry) => entry.storyId),
      [storyId],
    );
    const attempted = h.edits().length;
    h.setHook(undefined);
    h.advance(29_999);
    await h.service.syncFeedback();
    assert.equal(h.edits().length, attempted);
    h.advance(1);
    await h.service.syncFeedback();
    h.assertDelivered(0, 1, true);
    assert.deepEqual(h.store.pendingFeedbackCounts(), []);
  } finally {
    h.cleanup();
  }
});

test('count synchronization refuses a published record whose draft belongs to a different story', async () => {
  const h = harness();
  try {
    h.bindPreview();
    h.publications.savePublication({
      ...h.publication,
      draft: { ...draft, story: { ...draft.story, id: 456 } },
    });
    await h.service.syncFeedback();
    assert.equal(h.edits().length, 0);
    assert.deepEqual(h.store.pendingFeedbackCounts(), []);
  } finally {
    h.cleanup();
  }
});

test('count synchronization aggregates failures from every target and leaves the article pending', async () => {
  const h = harness();
  try {
    h.bindPreview();
    await h.dispatch(channelClick('like'));
    h.setHook(async (method, payload) => {
      if (method === 'editMessageReplyMarkup') {
        throw new Error(`Counter edit failed for ${(payload as Record<string, unknown>).chat_id}`);
      }
    });
    await assert.rejects(h.service.syncFeedback(), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(
        error.errors
          .map((entry: unknown) => {
            assert.ok(entry instanceof Error);
            return entry.message;
          })
          .sort(),
        [`Counter edit failed for ${channelId}`, `Counter edit failed for ${previewChatId}`].sort(),
      );
      return true;
    });
    assert.equal(h.edits().length, 2);
    assert.deepEqual(
      h.store.pendingFeedbackCounts().map((entry) => entry.storyId),
      [storyId],
    );
  } finally {
    h.cleanup();
  }
});

test('aborting a counter sync cancels its Telegram request without acknowledging pending state or delaying the next sync', async () => {
  const h = harness();
  const controller = new AbortController();
  try {
    h.bindPreview();
    await h.dispatch(channelClick('save'));
    h.setHook(async (method, _payload, signal) => {
      if (method === 'editMessageReplyMarkup') {
        assert.equal(signal, controller.signal);
        controller.abort();
        signal.throwIfAborted();
      }
    });
    await h.service.syncFeedback(controller.signal);
    assert.equal(h.edits().length, 1, 'No later targets should start after cancellation');
    assert.equal(h.delivered.size, 0);
    assert.deepEqual(
      h.store.pendingFeedbackCounts().map((entry) => entry.storyId),
      [storyId],
    );
    h.setHook(undefined);
    await h.service.syncFeedback();
    h.assertDelivered(0, 1, true);
    assert.deepEqual(h.store.pendingFeedbackCounts(), []);
  } finally {
    h.cleanup();
  }
});

test('feedback persisted while a publication is sending or uncertain stays pending until the canonical message is published', async () => {
  for (const state of ['sending', 'uncertain'] as const) {
    const h = harness();
    try {
      await h.dispatch(channelClick('save'));
      await h.dispatch(privateMessage('/saved'));
      const batch = h.latest();
      h.publications.savePublication({
        ...h.publication,
        state,
        messageId: null,
        publishedAt: null,
      });
      await h.dispatch(privateClick(batch, 'select:1'));
      await h.dispatch(privateClick(batch, 'like'));
      assert.deepEqual(h.store.feedbackCounts(storyId), { likes: 1, saves: 1 });
      const pending = h.store.pendingFeedbackCounts();
      assert.equal(pending.length, 1);
      await h.service.syncFeedback();
      assert.equal(h.edits().length, 0, state);
      assert.deepEqual(h.store.pendingFeedbackCounts(), pending, state);
      h.publications.savePublication(h.publication);
      h.advance(29_999);
      await h.service.syncFeedback();
      assert.equal(h.edits().length, 0, state);
      assert.deepEqual(h.store.pendingFeedbackCounts(), pending, state);
      h.advance(1);
      await h.service.syncFeedback();
      h.assertDelivered(1, 1);
      assert.deepEqual(h.store.pendingFeedbackCounts(), [], state);
    } finally {
      h.cleanup();
    }
  }
});

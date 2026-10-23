import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readyPublication } from '../src/domain.js';
import { ChannelFeedbackSync } from '../src/recommendations/channel-feedback-sync.js';
import { newReader } from '../src/recommendations/model.js';
import { ReadingStore } from '../src/recommendations/store.js';
import { SqlitePublicationRepository } from '../src/storage/sqlite-publication-repository.js';
import { draft } from './fixtures.js';

test('feedback arriving during historical keyboard backfill is sent next instead of waiting behind the backlog', async () => {
  const directory = mkdtempSync(join(process.cwd(), 'feedback-priority-test-'));
  const store = new ReadingStore(directory);
  const publications = new SqlitePublicationRepository(directory);
  let release = () => {};
  let started = () => {};
  const firstEdit = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const edits: Array<{ messageId: number; labels: string[] }> = [];
  for (let id = 1; id <= 30; id++) {
    publications.savePublication({
      ...readyPublication({ ...draft, story: { ...draft.story, id } }, 1),
      state: 'published',
      publishedAt: 1,
      page: { path: `article-${id}`, url: `https://telegra.ph/article-${id}` },
      messageId: 100 + id,
    });
  }
  const sync = new ChannelFeedbackSync(
    { chatId: '-1001', publications },
    store,
    {
      call: async (method, payload) => {
        assert.equal(method, 'editMessageReplyMarkup');
        const edit = payload as {
          message_id: number;
          reply_markup: { inline_keyboard: { text: string }[][] };
        };
        edits.push({
          messageId: edit.message_id,
          labels: edit.reply_markup.inline_keyboard.flat().map((button) => button.text),
        });
        if (edits.length === 1) {
          started();
          await pending;
        }
        return true;
      },
    },
    () => 1000,
  );
  const work = sync.sync();
  try {
    await firstEdit;
    const reader = newReader(200);
    reader.feedback[30] = { saved: true, opinion: 0, savedAt: 1000, revision: 1 };
    store.saveReader(reader);
    release();
    await work;
    assert.equal(edits[0]?.messageId, 101);
    assert.deepEqual(edits[1], { messageId: 130, labels: ['♡ 喜欢 0', '☆ 收藏 1'] });
    assert.equal(edits.length, 20);
    assert.equal(store.pendingFeedbackCounts().length, 10);
    assert.equal(
      store.pendingFeedbackCounts().some((item) => item.storyId === 30),
      false,
    );
  } finally {
    release();
    await work;
    store.close();
    publications.close();
    rmSync(directory, { recursive: true });
  }
});

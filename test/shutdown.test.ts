import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { TelegramClient } from '../src/adapters/telegram.js';
import { drainPublishing } from '../src/application/shutdown.js';
import { newReader } from '../src/recommendations/model.js';
import { ReadingStore } from '../src/recommendations/store.js';
import { draft } from './fixtures.js';

test('shutdown leaves feedback counts readable until an in-flight publication finishes its Telegram edit', async () => {
  const directory = mkdtempSync(join(process.cwd(), 'shutdown-test-'));
  const store = new ReadingStore(directory);
  const service = { isRunning: true };
  const closed: string[] = [];
  const reader = newReader(100);
  reader.feedback[draft.story.id] = { saved: true, opinion: 1, revision: 1, savedAt: 1 };
  store.saveReader(reader);
  const client = new TelegramClient(
    { TELEGRAM_BOT_TOKEN: 'test', TELEGRAM_CHAT_ID: '-1001', TELEGRAM_OWNER_ID: 100 },
    async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.reply_markup.inline_keyboard[0][0].text, '♡ 喜欢 1');
      assert.equal(payload.reply_markup.inline_keyboard[0][1].text, '☆ 收藏 1');
      return Response.json({ ok: true, result: { message_id: 1 } });
    },
    (storyId) => store.feedbackCounts(storyId),
  );
  const draining = drainPublishing(
    service,
    () => {
      store.close();
      closed.push('reading');
    },
    () => {
      closed.push('publications');
    },
    1000,
  );
  try {
    await client.edit(draft, { path: 'test', url: 'https://telegra.ph/test' }, 1);
    assert.deepEqual(closed, []);
    service.isRunning = false;
    assert.equal(await draining, true);
    assert.deepEqual(closed, ['reading', 'publications']);
  } finally {
    service.isRunning = false;
    await draining;
    rmSync(directory, { recursive: true });
  }
});

test('shutdown timeout leaves both stores available to unfinished publication work', async () => {
  const closed: string[] = [];
  assert.equal(
    await drainPublishing(
      { isRunning: true },
      () => {
        closed.push('reading');
      },
      () => {
        closed.push('publications');
      },
      0,
    ),
    false,
  );
  assert.deepEqual(closed, []);
});

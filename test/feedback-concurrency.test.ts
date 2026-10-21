import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { newReader } from '../src/recommendations/model.js';
import { ReadingStore } from '../src/recommendations/store.js';

test('saving an in-flight reader snapshot preserves newer channel feedback and unrelated profile updates', () => {
  const directory = mkdtempSync(join(process.cwd(), 'data-test-feedback-race-'));
  const store = new ReadingStore(directory);
  try {
    store.saveReader(newReader(100));
    const pendingModel = store.reader(100);
    const channelClick = store.reader(100);
    assert.ok(pendingModel && channelClick);
    channelClick.feedback[123] = { saved: true, opinion: 1, revision: 2, savedAt: 1000 };
    store.saveReader(channelClick);
    pendingModel.interests = [{ name: '数据库', query: 'database', weight: 2 }];
    store.saveReader(pendingModel);
    assert.deepEqual(store.reader(100)?.feedback[123], channelClick.feedback[123]);
    assert.deepEqual(store.reader(100)?.interests, pendingModel.interests);

    const stale = store.reader(100);
    const latest = store.reader(100);
    assert.ok(stale && latest);
    latest.feedback[123] = { saved: false, opinion: 1, revision: 3, savedAt: 1000 };
    store.saveReader(latest);
    stale.feedback[456] = { saved: true, opinion: 0, revision: 1, savedAt: 2000 };
    store.saveReader(stale);
    assert.deepEqual(store.reader(100)?.feedback, {
      123: latest.feedback[123],
      456: stale.feedback[456],
    });
    assert.deepEqual(stale.feedback[123], latest.feedback[123]);
  } finally {
    store.close();
    rmSync(directory, { recursive: true });
  }
});

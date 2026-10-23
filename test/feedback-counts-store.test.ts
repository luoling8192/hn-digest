import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { newReader } from '../src/recommendations/model.js';
import { ReadingStore } from '../src/recommendations/store.js';

function harness() {
  const directory = mkdtempSync(join(process.cwd(), 'data-test-feedback-counts-'));
  let store = new ReadingStore(directory);
  return {
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new ReadingStore(directory);
    },
    close() {
      store.close();
      rmSync(directory, { recursive: true });
    },
  };
}

test('counts aggregate historical current reader state once per account without a counter backfill', () => {
  const h = harness();
  try {
    const first = newReader(100);
    first.feedback[123] = { saved: true, opinion: 1, revision: 5, savedAt: 20 };
    first.feedback[456] = { saved: false, opinion: 1, revision: 1, savedAt: 0 };
    const second = newReader(200);
    second.feedback[123] = { saved: true, opinion: -1, revision: 4, savedAt: 40 };
    h.store.put('reader:100', first);
    h.store.put('reader:200', second);
    h.store.put('batch:historical', { feedback: first.feedback });
    h.reopen();
    assert.deepEqual(h.store.feedbackCounts(123), { likes: 1, saves: 2 });
    assert.deepEqual(h.store.feedbackCounts(456), { likes: 1, saves: 0 });
    assert.deepEqual(h.store.feedbackCounts(789), { likes: 0, saves: 0 });
    assert.deepEqual(h.store.pendingFeedbackCounts(), []);
    h.store.saveReader(first);
    h.store.saveReader(first);
    assert.deepEqual(h.store.feedbackCounts(123), { likes: 1, saves: 2 });
    assert.deepEqual(h.store.pendingFeedbackCounts(), []);
  } finally {
    h.close();
  }
});

test('only effective saved and liked changes mark a story for synchronization', () => {
  const h = harness();
  try {
    const reader = newReader(100);
    h.store.saveReader(reader);
    reader.feedback[123] = { saved: false, opinion: -1, revision: 1, savedAt: 0 };
    h.store.saveReader(reader);
    reader.feedback[123].opinion = 0;
    reader.feedback[123].revision += 1;
    h.store.saveReader(reader);
    assert.deepEqual(h.store.pendingFeedbackCounts(), []);

    reader.feedback[123].saved = true;
    reader.feedback[123].revision += 1;
    h.store.saveReader(reader);
    assert.deepEqual(h.store.feedbackCounts(123), { likes: 0, saves: 1 });
    assert.deepEqual(h.store.pendingFeedbackCounts(), [{ storyId: 123, revision: 1 }]);
    h.store.ackFeedbackCounts(123, 1);

    reader.feedback[123].savedAt = 999;
    reader.feedback[123].revision += 1;
    reader.interests = [];
    h.store.saveReader(reader);
    assert.deepEqual(h.store.pendingFeedbackCounts(), []);

    reader.feedback[123].opinion = 1;
    reader.feedback[123].revision += 1;
    h.store.saveReader(reader);
    assert.deepEqual(h.store.feedbackCounts(123), { likes: 1, saves: 1 });
    assert.deepEqual(h.store.pendingFeedbackCounts(), [{ storyId: 123, revision: 2 }]);

    reader.feedback[123].opinion = -1;
    reader.feedback[123].saved = false;
    reader.feedback[123].revision += 1;
    h.store.saveReader(reader);
    assert.deepEqual(h.store.feedbackCounts(123), { likes: 0, saves: 0 });
    assert.deepEqual(h.store.pendingFeedbackCounts(), [{ storyId: 123, revision: 3 }]);
  } finally {
    h.close();
  }
});

test('a stale reader merge preserves newer feedback without dirtying unchanged totals', () => {
  const h = harness();
  try {
    h.store.saveReader(newReader(100));
    const stale = h.store.reader(100);
    const current = h.store.reader(100);
    assert.ok(stale && current);
    current.feedback[123] = { saved: true, opinion: 1, revision: 2, savedAt: 20 };
    h.store.saveReader(current);
    h.store.ackFeedbackCounts(123, 1);
    stale.feedback[456] = { saved: true, opinion: 0, revision: 1, savedAt: 40 };
    stale.interests = [];
    h.store.saveReader(stale);
    assert.deepEqual(h.store.feedbackCounts(123), { likes: 1, saves: 1 });
    assert.deepEqual(h.store.feedbackCounts(456), { likes: 0, saves: 1 });
    assert.deepEqual(h.store.pendingFeedbackCounts(), [{ storyId: 456, revision: 1 }]);
    assert.deepEqual(h.store.reader(100)?.feedback[123], current.feedback[123]);
    assert.deepEqual(h.store.reader(100)?.interests, []);
  } finally {
    h.close();
  }
});

test('new feedback from separate readers counts independently and one save marks each affected story once', () => {
  const h = harness();
  try {
    for (const userId of [100, 200]) {
      const reader = newReader(userId);
      reader.feedback[123] = { saved: true, opinion: 1, revision: 1, savedAt: 20 };
      reader.feedback[456] = { saved: false, opinion: 1, revision: 1, savedAt: 0 };
      h.store.saveReader(reader);
    }
    assert.deepEqual(h.store.feedbackCounts(123), { likes: 2, saves: 2 });
    assert.deepEqual(h.store.feedbackCounts(456), { likes: 2, saves: 0 });
    assert.deepEqual(h.store.pendingFeedbackCounts(), [
      { storyId: 123, revision: 2 },
      { storyId: 456, revision: 2 },
    ]);
  } finally {
    h.close();
  }
});

test('acknowledging an in-flight old revision preserves the newer pending change across restart', () => {
  const h = harness();
  try {
    h.store.markFeedbackCounts(123);
    const pending = h.store.pendingFeedbackCounts();
    assert.equal(pending.length, 1);
    const first = pending[0];
    assert.ok(first);
    h.store.markFeedbackCounts(123);
    h.store.ackFeedbackCounts(123, first.revision);
    h.reopen();
    assert.deepEqual(h.store.pendingFeedbackCounts(), [{ storyId: 123, revision: 2 }]);
    h.store.ackFeedbackCounts(123, 2);
    h.reopen();
    assert.deepEqual(h.store.pendingFeedbackCounts(), []);
    h.store.markFeedbackCounts(123);
    h.store.ackFeedbackCounts(123, 1);
    assert.deepEqual(h.store.pendingFeedbackCounts(), [{ storyId: 123, revision: 3 }]);
    h.store.ackFeedbackCounts(456, 1);
    assert.deepEqual(h.store.pendingFeedbackCounts(), [{ storyId: 123, revision: 3 }]);
  } finally {
    h.close();
  }
});

test('outer rollback reverts feedback and its nested dirty mark together', () => {
  const h = harness();
  try {
    assert.throws(
      () =>
        h.store.transaction(() => {
          const reader = newReader(100);
          reader.feedback[123] = { saved: true, opinion: 1, revision: 1, savedAt: 20 };
          h.store.saveReader(reader);
          assert.deepEqual(h.store.pendingFeedbackCounts(), [{ storyId: 123, revision: 1 }]);
          throw new Error('abort outer');
        }),
      /abort outer/,
    );
    assert.equal(h.store.reader(100), null);
    assert.deepEqual(h.store.feedbackCounts(123), { likes: 0, saves: 0 });
    assert.deepEqual(h.store.pendingFeedbackCounts(), []);
  } finally {
    h.close();
  }
});

test('caught inner rollback leaves the outer transaction usable and retains only committed dirty work', () => {
  const h = harness();
  try {
    h.store.transaction(() => {
      h.store.markFeedbackCounts(123);
      assert.throws(
        () =>
          h.store.transaction(() => {
            h.store.markFeedbackCounts(456);
            throw new Error('abort inner');
          }),
        /abort inner/,
      );
      h.store.markFeedbackCounts(789);
    });
    h.reopen();
    assert.deepEqual(h.store.pendingFeedbackCounts(), [
      { storyId: 123, revision: 1 },
      { storyId: 789, revision: 1 },
    ]);
  } finally {
    h.close();
  }
});

test('saveReader validates before persisting reader state or any dirty markers', () => {
  const h = harness();
  try {
    const reader = newReader(100);
    reader.feedback[123] = { saved: true, opinion: 1, revision: 1, savedAt: 20 };
    reader.history = [{ role: 'assistant', content: 'valid' }];
    reader.interests = Array(9).fill({ name: 'too many', query: 'topics', weight: 1 });
    assert.throws(() => h.store.saveReader(reader));
    assert.equal(h.store.reader(100), null);
    assert.deepEqual(h.store.pendingFeedbackCounts(), []);
  } finally {
    h.close();
  }
});

test('a failing dirty marker rolls back every feedback change in the reader save', () => {
  const h = harness();
  try {
    h.store.saveReader(newReader(100));
    const reader = newReader(100);
    reader.feedback[123] = { saved: true, opinion: 1, revision: 1, savedAt: 20 };
    reader.feedback.invalid = { saved: true, opinion: 0, revision: 1, savedAt: 40 };
    assert.throws(() => h.store.saveReader(reader));
    assert.deepEqual(h.store.reader(100)?.feedback, {});
    assert.deepEqual(h.store.feedbackCounts(123), { likes: 0, saves: 0 });
    assert.deepEqual(h.store.pendingFeedbackCounts(), []);
  } finally {
    h.close();
  }
});

test('preview bindings expose only validated chat, message and story identifiers across restart', () => {
  const h = harness();
  try {
    h.store.put('channel-preview:-100123:45', { storyId: 456 });
    h.store.put('channel-preview:-100123:46', { storyId: 789 });
    h.store.put('unrelated:-100123:47', { storyId: 999 });
    h.reopen();
    assert.deepEqual(h.store.channelPreviewBindings(), [
      { chatId: '-100123', messageId: 45, storyId: 456 },
      { chatId: '-100123', messageId: 46, storyId: 789 },
    ]);
    h.store.put('channel-preview:-100123:47', { storyId: -1 });
    assert.throws(() => h.store.channelPreviewBindings());
  } finally {
    h.close();
  }
});

test('malformed preview keys and unsafe identifiers are rejected instead of being sent to Telegram', () => {
  const h = harness();
  try {
    h.store.put('channel-preview:channel:45', { storyId: 123 });
    assert.throws(() => h.store.channelPreviewBindings());
  } finally {
    h.close();
  }
  const unsafe = harness();
  try {
    unsafe.store.put('channel-preview:-100123:9007199254740992', { storyId: 123 });
    assert.throws(() => unsafe.store.channelPreviewBindings());
  } finally {
    unsafe.close();
  }
});

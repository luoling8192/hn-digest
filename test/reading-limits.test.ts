import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ReadingLimits } from '../src/recommendations/limits.js';
import { ReadingStore } from '../src/recommendations/store.js';

function harness() {
  const directory = mkdtempSync(join(process.cwd(), 'reading-limits-test-'));
  const time = { value: Date.UTC(2026, 9, 23, 0) };
  let store = new ReadingStore(directory);
  let limits = new ReadingLimits(store, () => time.value);
  return {
    time,
    get limits() {
      return limits;
    },
    reopen() {
      store.close();
      store = new ReadingStore(directory);
      limits = new ReadingLimits(store, () => time.value);
    },
    stateCount() {
      const db = new DatabaseSync(join(directory, 'reading.sqlite'), { readOnly: true });
      try {
        return db.prepare('SELECT COUNT(*) AS count FROM reading_state').get()?.count;
      } finally {
        db.close();
      }
    },
    cleanup() {
      store.close();
      rmSync(directory, { recursive: true });
    },
  };
}

test('public actions allow a burst of ten then refill thirty tokens per minute', (t) => {
  const h = harness();
  t.after(h.cleanup);
  for (let i = 0; i < 10; i++) {
    assert.deepEqual(h.limits.admitPublicAction(1), { allowed: true });
  }
  assert.deepEqual(h.limits.admitPublicAction(1), {
    allowed: false,
    reason: 'user',
    retryAfterSeconds: 2,
    notify: true,
  });
  h.time.value += 1999;
  assert.deepEqual(h.limits.admitPublicAction(1), {
    allowed: false,
    reason: 'user',
    retryAfterSeconds: 1,
    notify: false,
  });
  h.time.value++;
  assert.deepEqual(h.limits.admitPublicAction(1), { allowed: true });
  assert.equal(h.limits.admitPublicAction(1).allowed, false);
});

test('global burst and refill apply across users without consuming denied user tokens', (t) => {
  const h = harness();
  t.after(h.cleanup);
  for (let userId = 1; userId <= 10; userId++) {
    assert.deepEqual(h.limits.admitPublicAction(userId), { allowed: true });
  }
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(h.limits.admitPublicAction(100), {
      allowed: false,
      reason: 'global',
      retryAfterSeconds: 1,
      notify: i === 0,
    });
  }
  for (let i = 0; i < 10; i++) {
    h.time.value += 200;
    assert.deepEqual(h.limits.admitPublicAction(100), { allowed: true });
  }
});

test('a user rejection leaves the global quota available for other readers', (t) => {
  const h = harness();
  t.after(h.cleanup);
  for (let i = 0; i < 10; i++) h.limits.admitPublicAction(1);
  h.time.value += 2000;
  assert.deepEqual(h.limits.admitPublicAction(1), { allowed: true });
  assert.equal(h.limits.admitPublicAction(1).allowed, false);
  for (let userId = 2; userId <= 10; userId++) {
    assert.deepEqual(h.limits.admitPublicAction(userId), { allowed: true });
  }
  assert.deepEqual(h.limits.admitPublicAction(11), {
    allowed: false,
    reason: 'global',
    retryAfterSeconds: 1,
    notify: true,
  });
});

test('rejection notices are limited to one per thirty seconds and survive restart', (t) => {
  const h = harness();
  t.after(h.cleanup);
  for (let i = 0; i < 10; i++) h.limits.admitPublicAction(1);
  assert.equal(h.limits.admitPublicAction(1).allowed, false);
  h.reopen();
  assert.deepEqual(h.limits.admitPublicAction(1), {
    allowed: false,
    reason: 'user',
    retryAfterSeconds: 2,
    notify: false,
  });
  assert.deepEqual(h.limits.admitPublicAction(2), {
    allowed: false,
    reason: 'global',
    retryAfterSeconds: 1,
    notify: true,
  });
  h.time.value += 29999;
  for (let i = 0; i < 10; i++) h.limits.admitPublicAction(1);
  assert.deepEqual(h.limits.admitPublicAction(1), {
    allowed: false,
    reason: 'user',
    retryAfterSeconds: 2,
    notify: false,
  });
  h.time.value++;
  assert.deepEqual(h.limits.admitPublicAction(1), {
    allowed: false,
    reason: 'user',
    retryAfterSeconds: 2,
    notify: true,
  });
});

test('recommendation checks do not consume a batch; recording starts a persistent cooldown', (t) => {
  const h = harness();
  t.after(h.cleanup);
  for (let i = 0; i < 30; i++) {
    assert.deepEqual(h.limits.checkRecommendation(1), { allowed: true });
  }
  assert.equal(h.stateCount(), 0);
  h.limits.recordRecommendation(1);
  assert.deepEqual(h.limits.checkRecommendation(1), {
    allowed: false,
    reason: 'cooldown',
    retryAfterSeconds: 30,
  });
  h.reopen();
  h.time.value += 29999;
  assert.deepEqual(h.limits.checkRecommendation(1), {
    allowed: false,
    reason: 'cooldown',
    retryAfterSeconds: 1,
  });
  h.time.value++;
  assert.deepEqual(h.limits.checkRecommendation(1), { allowed: true });
  assert.deepEqual(h.limits.checkRecommendation(2), { allowed: true });
});

test('twenty recorded batches use the daily quota until midnight UTC plus eight', (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.time.value = Date.UTC(2026, 9, 23, 15, 49, 30);
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(h.limits.checkRecommendation(1), { allowed: true });
    h.limits.recordRecommendation(1);
    h.time.value += 30000;
  }
  assert.deepEqual(h.limits.checkRecommendation(1), {
    allowed: false,
    reason: 'daily',
    retryAfterSeconds: 30,
  });
  h.reopen();
  h.time.value = Date.UTC(2026, 9, 23, 15, 59, 59, 999);
  assert.deepEqual(h.limits.checkRecommendation(1), {
    allowed: false,
    reason: 'daily',
    retryAfterSeconds: 1,
  });
  h.time.value++;
  assert.deepEqual(h.limits.checkRecommendation(1), { allowed: true });
  h.limits.recordRecommendation(1);
  h.time.value += 30000;
  assert.deepEqual(h.limits.checkRecommendation(1), { allowed: true });
});

test('rolling the clock backwards neither refills tokens nor clears quotas', (t) => {
  const h = harness();
  t.after(h.cleanup);
  for (let i = 0; i < 10; i++) h.limits.admitPublicAction(1);
  h.limits.recordRecommendation(1);
  const recordedAt = h.time.value;
  h.time.value -= 10000;
  assert.deepEqual(h.limits.admitPublicAction(1), {
    allowed: false,
    reason: 'user',
    retryAfterSeconds: 12,
    notify: true,
  });
  assert.deepEqual(h.limits.checkRecommendation(1), {
    allowed: false,
    reason: 'cooldown',
    retryAfterSeconds: 40,
  });
  h.time.value = recordedAt + 30000;
  for (let i = 1; i < 20; i++) {
    h.limits.recordRecommendation(1);
    h.time.value += 30000;
  }
  h.time.value = recordedAt - 24 * 60 * 60 * 1000;
  const blocked = h.limits.checkRecommendation(1);
  assert.equal(blocked.allowed, false);
  if (blocked.allowed) assert.fail('Clock rollback must preserve the daily quota');
  assert.equal(blocked.reason, 'daily');
  assert.ok(blocked.retryAfterSeconds > 0);
});

test('limiter storage stays bounded per reader across requests and days', (t) => {
  const h = harness();
  t.after(h.cleanup);
  for (let day = 0; day < 30; day++) {
    for (let i = 0; i < 100; i++) h.limits.admitPublicAction(1);
    h.limits.recordRecommendation(1);
    h.time.value += 24 * 60 * 60 * 1000;
  }
  assert.equal(h.stateCount(), 2);
});

test('timestamps before the epoch produce valid state and nonnegative retry delays', (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.time.value = -1000;
  for (let i = 0; i < 10; i++) {
    assert.deepEqual(h.limits.admitPublicAction(1), { allowed: true });
  }
  h.limits.recordRecommendation(1);
  h.reopen();
  assert.deepEqual(h.limits.admitPublicAction(1), {
    allowed: false,
    reason: 'user',
    retryAfterSeconds: 2,
    notify: true,
  });
  assert.deepEqual(h.limits.checkRecommendation(1), {
    allowed: false,
    reason: 'cooldown',
    retryAfterSeconds: 30,
  });
});

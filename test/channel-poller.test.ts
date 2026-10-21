import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { type LogFields, type Logger, silentLogger } from '../src/logger.js';
import { ReadingPoller } from '../src/recommendations/poller.js';
import type { ReadingTransport, ReadingUpdate } from '../src/recommendations/service.js';
import { ReadingStore } from '../src/recommendations/store.js';

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function update(id: number, immediate = false): ReadingUpdate {
  return immediate
    ? {
        update_id: id,
        callback_query: {
          id: `callback-${id}`,
          from: { id: 100, is_bot: false },
          data: 'd:like:1',
          message: { message_id: 1, chat: { id: -100123, type: 'channel' } },
        },
      }
    : {
        update_id: id,
        message: {
          message_id: id,
          from: { id: 100, is_bot: false },
          chat: { id: 100, type: 'private' },
          text: '推荐',
        },
      };
}

function harness(
  batches: ReadingUpdate[][],
  handle: (update: ReadingUpdate, store: ReadingStore) => Promise<void>,
  logger: Logger = silentLogger,
  reportFailure: (update: ReadingUpdate) => Promise<void> = async () => {},
) {
  const directory = mkdtempSync(join(process.cwd(), 'channel-poller-test-'));
  const store = new ReadingStore(directory);
  const requests: Record<string, unknown>[] = [];
  let aborted = false;
  const transport: ReadingTransport = {
    call: async (method, payload, signal) => {
      assert.equal(method, 'getUpdates');
      requests.push({ ...payload });
      const batch = batches.shift();
      if (batch) return batch;
      assert.ok(signal);
      return new Promise((_resolve, reject) => {
        const abort = () => {
          aborted = true;
          reject(new DOMException('Polling stopped', 'AbortError'));
        };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    },
  };
  const service = {
    accepts: () => true,
    isImmediate: (candidate: ReadingUpdate) => candidate.callback_query !== undefined,
    handle: (candidate: ReadingUpdate) => handle(candidate, store),
    reportFailure,
  };
  return {
    store,
    requests,
    poller: new ReadingPoller(store, transport, service, logger),
    get aborted() {
      return aborted;
    },
    cleanup() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test('later polling batches handle channel feedback while reading is blocked, without replaying claims', async () => {
  const reading = deferred();
  const handled: number[] = [];
  let readingFinished = false;
  const h = harness([[update(10)], [update(11, true)], [update(11, true)]], async (item, store) => {
    assert.ok(store.offset > item.update_id, 'the persisted cursor must precede effects');
    handled.push(item.update_id);
    if (item.update_id === 10) {
      await reading.promise;
      readingFinished = true;
    }
  });
  try {
    h.poller.start();
    h.poller.start();
    await turn();
    assert.deepEqual(handled, [10, 11]);
    assert.equal(h.store.offset, 12);
    assert.equal(readingFinished, false);
    assert.equal(h.requests.length, 4, 'start must not create a second poll loop');

    let stopped = false;
    const stopping = h.poller.stop().then(() => {
      stopped = true;
    });
    await turn();
    assert.equal(h.aborted, true);
    assert.equal(stopped, false, 'stop must drain the in-flight reader before closing its store');
    reading.resolve();
    await stopping;
    assert.equal(readingFinished, true);
    assert.equal(h.poller.status().polling, false);
  } finally {
    reading.resolve();
    await h.poller.stop();
    h.cleanup();
  }
});

test('normal updates remain FIFO and bounded, and the next freed slot resumes polling', async () => {
  const first = deferred();
  const remaining = deferred();
  const started: number[] = [];
  const completed: number[] = [];
  const h = harness(
    [Array.from({ length: 25 }, (_, index) => update(index + 1)), [update(26, true)]],
    async (item) => {
      if (item.callback_query) {
        completed.push(item.update_id);
        return;
      }
      started.push(item.update_id);
      await (item.update_id === 1 ? first.promise : remaining.promise);
      completed.push(item.update_id);
    },
  );
  try {
    h.poller.start();
    await turn();
    assert.deepEqual(started, [1]);
    assert.equal(h.requests.length, 1, 'a full queue must stop claiming more normal updates');
    assert.equal(h.store.offset, 26);

    first.resolve();
    await turn();
    assert.deepEqual(started, [1, 2]);
    assert.deepEqual(completed, [1, 26]);
    assert.equal(h.requests[1]?.limit, 1);
    assert.equal(h.store.offset, 27);

    const stopping = h.poller.stop();
    remaining.resolve();
    await stopping;
    assert.deepEqual(
      started,
      Array.from({ length: 25 }, (_, index) => index + 1),
    );
    assert.deepEqual(completed, [1, 26, ...Array.from({ length: 24 }, (_, index) => index + 2)]);
    assert.equal(h.requests.length, 3);
  } finally {
    first.resolve();
    remaining.resolve();
    await h.poller.stop();
    h.cleanup();
  }
});

test('pollOnce drains normal work and reports failures without breaking following updates', async () => {
  const errors: { event: string; fields: LogFields | undefined }[] = [];
  const warnings: { event: string; fields: LogFields | undefined }[] = [];
  const reported: number[] = [];
  const handled: number[] = [];
  const h = harness(
    [[update(1), update(2, true), update(3)]],
    async (item) => {
      handled.push(item.update_id);
      if (item.update_id < 3) throw new TypeError('Failed action');
    },
    {
      info: () => {},
      error: (event, fields) => errors.push({ event, fields }),
      warn: (event, fields) => warnings.push({ event, fields }),
    },
    async (item) => {
      reported.push(item.update_id);
      if (item.update_id === 2) throw new RangeError('Failed notification');
    },
  );
  try {
    await h.poller.pollOnce();
    assert.deepEqual([...handled].sort(), [1, 2, 3]);
    assert.deepEqual([...reported].sort(), [1, 2]);
    assert.deepEqual(
      errors.sort((one, two) => Number(one.fields?.updateId) - Number(two.fields?.updateId)),
      [
        { event: 'reading_update_failed', fields: { updateId: 1, code: 'TypeError' } },
        { event: 'reading_update_failed', fields: { updateId: 2, code: 'TypeError' } },
      ],
    );
    assert.deepEqual(warnings, [
      { event: 'reading_error_notification_failed', fields: { code: 'RangeError' } },
    ]);
    assert.equal(h.store.offset, 4);
  } finally {
    await h.poller.stop();
    h.cleanup();
  }
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Article } from '../src/domain.js';
import { ApplicationError, RemoteHttpError } from '../src/errors.js';
import { silentLogger } from '../src/logger.js';
import {
  OpenRouterReadingAssistant,
  type ReadingAssistant,
} from '../src/recommendations/assistant.js';
import { ReadingBackfill } from '../src/recommendations/backfill.js';
import { articleFromCandidate } from '../src/recommendations/catalog.js';
import type { Candidate } from '../src/recommendations/model.js';
import { ReadingStore } from '../src/recommendations/store.js';

const SIX_HOURS = 6 * 3_600_000;
const unavailable: Article = { text: '', source: 'unavailable', readingMinutes: null };
const source: Article = {
  text: 'An engineering investigation with concrete measurements and implementation details. '.repeat(
    12,
  ),
  source: 'article',
  readingMinutes: 2,
};

function candidate(id: number, changes: Partial<Candidate> = {}): Candidate {
  return {
    id,
    title: `Engineering lessons ${id}`,
    url: `https://example.com/${id}`,
    score: 700 - id,
    comments: 30,
    time: 1_600_000_000,
    topics: ['工程经验'],
    status: 'pending',
    attemptedAt: null,
    ...changes,
  };
}

function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'hn-backfill-retry-'));
  const store = new ReadingStore(directory);
  let now = 1_790_000_000_000;
  store.put('archive:state', { month: 60, anchor: now, lastStep: null });
  const assistant: ReadingAssistant = {
    annotate: async (articles) => articles,
    understand: async () => {
      throw new Error('Unexpected command');
    },
    explain: async () => {
      throw new Error('Unexpected explanation');
    },
  };
  const http = {
    request: async () => {
      throw new Error('Unexpected index request');
    },
  };
  return {
    directory,
    store,
    assistant,
    http,
    now: () => now,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    cleanup: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('failed archive sources retry after six hours and retain their retry deadline across reopen', async () => {
  const h = harness();
  let attempts = 0;
  const extractor = {
    extract: async () => (++attempts === 1 ? unavailable : source),
  };
  try {
    h.store.saveCandidate(candidate(1, { status: 'failed', attemptedAt: h.now() - SIX_HOURS }));
    const backfill = new ReadingBackfill(
      h.store,
      h.http,
      extractor,
      h.assistant,
      100,
      silentLogger,
      1,
      h.now,
    );
    await backfill.step();
    assert.equal(attempts, 1);
    assert.equal(h.store.candidate(1)?.attemptedAt, h.now());
    assert.equal(h.store.candidate(1)?.status, 'failed');

    const reopened = new ReadingStore(h.directory);
    try {
      const restarted = new ReadingBackfill(
        reopened,
        h.http,
        extractor,
        h.assistant,
        100,
        silentLogger,
        1,
        h.now,
      );
      h.advance(SIX_HOURS - 1);
      await restarted.step();
      assert.equal(attempts, 1);
      h.advance(1);
      await restarted.step();
      assert.equal(attempts, 2);
      assert.equal(reopened.candidate(1)?.status, 'ready');
      assert.equal(reopened.source(1)?.text, source.text);
    } finally {
      reopened.close();
    }
  } finally {
    h.cleanup();
  }
});

test('a full archive retries at most one failed source per step without processing pending inventory', async () => {
  const h = harness();
  const fetched: number[] = [];
  try {
    h.store.saveCandidate(candidate(1, { status: 'ready', attemptedAt: h.now() }));
    h.store.saveArticle(articleFromCandidate(candidate(1), source));
    for (const id of [2, 3]) {
      h.store.saveCandidate(candidate(id, { status: 'failed', attemptedAt: h.now() - SIX_HOURS }));
    }
    h.store.saveCandidate(candidate(4));
    const backfill = new ReadingBackfill(
      h.store,
      h.http,
      {
        extract: async (story) => {
          fetched.push(story.id);
          return source;
        },
      },
      h.assistant,
      100,
      silentLogger,
      1,
      h.now,
    );
    assert.equal(await backfill.step(), true);
    assert.deepEqual(fetched, [2]);
    assert.equal(h.store.inventory().parsed, 2);
    assert.equal(h.store.candidate(3)?.status, 'failed');
    assert.equal(h.store.candidate(4)?.status, 'pending');
    await backfill.step();
    assert.deepEqual(fetched, [2, 3]);
    assert.equal(h.store.inventory().parsed, 3);
    assert.equal(h.store.article(4), null);
  } finally {
    h.cleanup();
  }
});

test('failed archive retries reach the oldest candidate despite recurring failures and higher priority pending work', async () => {
  const h = harness();
  const fetched: number[] = [];
  const extractor = {
    extract: async (story: { id: number }) => {
      fetched.push(story.id);
      return unavailable;
    },
  };
  try {
    h.store.saveCandidate(candidate(99, { status: 'ready', attemptedAt: h.now() }));
    h.store.saveArticle(articleFromCandidate(candidate(99), source));
    for (let id = 1; id <= 7; id++) {
      h.store.saveCandidate(candidate(id, { status: 'failed', attemptedAt: h.now() - SIX_HOURS }));
    }
    const full = new ReadingBackfill(
      h.store,
      h.http,
      extractor,
      h.assistant,
      100,
      silentLogger,
      1,
      h.now,
    );
    for (let hour = 0; hour < 14; hour++) {
      await full.step();
      h.advance(3_600_000);
    }
    assert.deepEqual(fetched, [1, 2, 3, 4, 5, 6, 7, 1, 2, 3, 4, 5, 6, 7]);

    h.store.saveCandidate(candidate(100, { score: 10000 }));
    const filling = new ReadingBackfill(
      h.store,
      h.http,
      extractor,
      h.assistant,
      100,
      silentLogger,
      2,
      h.now,
    );
    await filling.step();
    assert.equal(fetched.at(-1), 1);
    assert.equal(h.store.candidate(100)?.status, 'pending');
  } finally {
    h.cleanup();
  }
});

test('unavailable cached sources are fetched again before archive annotation', async () => {
  const h = harness();
  let attempts = 0;
  try {
    h.store.saveCandidate(candidate(1));
    h.store.saveSource(1, unavailable);
    const backfill = new ReadingBackfill(
      h.store,
      h.http,
      {
        extract: async () => {
          attempts++;
          return source;
        },
      },
      h.assistant,
      100,
      silentLogger,
      1,
      h.now,
    );
    await backfill.step();
    assert.equal(attempts, 1);
    assert.equal(h.store.candidate(1)?.status, 'ready');
    assert.equal(h.store.source(1)?.text, source.text);
  } finally {
    h.cleanup();
  }
});

test('cached error pages, insufficient text, and challenges are fetched again before annotation', async () => {
  const h = harness();
  const fetched: number[] = [];
  try {
    const badTexts = [
      `Page not found. ${source.text}`,
      'An incomplete response.',
      `Verify you are human. ${source.text}`,
    ];
    for (const [index, text] of badTexts.entries()) {
      const id = index + 1;
      h.store.saveCandidate(candidate(id));
      h.store.saveSource(id, { ...source, text });
    }
    const backfill = new ReadingBackfill(
      h.store,
      h.http,
      {
        extract: async (story) => {
          fetched.push(story.id);
          return source;
        },
      },
      h.assistant,
      100,
      silentLogger,
      3,
      h.now,
    );
    await backfill.step();
    assert.deepEqual(fetched, [1, 2, 3]);
    assert.equal(h.store.inventory().parsed, 3);
    for (const id of [1, 2, 3]) assert.equal(h.store.source(id)?.text, source.text);
  } finally {
    h.cleanup();
  }
});

test('a source fetch exception and an annotation error do not discard other archive candidates', async () => {
  const h = harness();
  const warnings: { event: string; storyId?: unknown; code?: unknown }[] = [];
  try {
    for (const id of [1, 2, 3]) h.store.saveCandidate(candidate(id));
    const backfill = new ReadingBackfill(
      h.store,
      h.http,
      {
        extract: async (story) => {
          if (story.id === 1)
            throw new ApplicationError('origin_temporarily_unavailable', 503, 'Temporary failure');
          return source;
        },
      },
      {
        ...h.assistant,
        annotate: async (articles) => {
          if (articles[0]?.id === 3)
            throw new ApplicationError(
              'annotation_temporarily_unavailable',
              503,
              'Temporary failure',
            );
          return articles;
        },
      },
      100,
      { ...silentLogger, warn: (event, fields) => warnings.push({ event, ...fields }) },
      3,
      h.now,
    );
    await backfill.step();
    assert.equal(h.store.candidate(1)?.status, 'failed');
    assert.equal(h.store.candidate(1)?.attemptedAt, h.now());
    assert.equal(h.store.candidate(2)?.status, 'ready');
    assert.equal(h.store.article(2)?.evidence, 'fulltext');
    assert.equal(h.store.candidate(3)?.status, 'failed');
    assert.equal(h.store.source(3)?.text, source.text);
    assert.deepEqual(warnings, [
      {
        event: 'reading_article_fetch_failed',
        storyId: 1,
        code: 'origin_temporarily_unavailable',
      },
      {
        event: 'reading_annotation_failed',
        storyId: 3,
        code: 'annotation_temporarily_unavailable',
      },
    ]);
  } finally {
    h.cleanup();
  }
});

test('technical CAPTCHA articles remain readable archive candidates', async () => {
  const h = harness();
  try {
    h.store.saveCandidate(candidate(1));
    const text = `CAPTCHA systems face new automated solvers. ${source.text}`;
    const backfill = new ReadingBackfill(
      h.store,
      h.http,
      { extract: async () => ({ ...source, text }) },
      h.assistant,
      100,
      silentLogger,
      1,
      h.now,
    );
    await backfill.step();
    assert.equal(h.store.candidate(1)?.status, 'ready');
    assert.equal(h.store.source(1)?.text, text);
  } finally {
    h.cleanup();
  }
});

test('annotation retries reuse readable sources while only one failed candidate runs per step', async () => {
  const h = harness();
  const annotations: number[] = [];
  try {
    for (const id of [1, 2]) {
      h.store.saveCandidate(candidate(id, { status: 'failed', attemptedAt: h.now() - SIX_HOURS }));
      h.store.saveSource(id, source);
    }
    h.store.saveCandidate(candidate(3));
    const fetched: number[] = [];
    const backfill = new ReadingBackfill(
      h.store,
      h.http,
      {
        extract: async (story) => {
          fetched.push(story.id);
          return source;
        },
      },
      {
        ...h.assistant,
        annotate: async (articles, _reader, sources) => {
          const id = articles[0]?.id;
          assert.equal(typeof id, 'number');
          if (id === undefined) throw new Error('Missing candidate');
          assert.equal(sources.get(id)?.text, source.text);
          annotations.push(id);
          return articles;
        },
      },
      100,
      silentLogger,
      3,
      h.now,
    );
    await backfill.step();
    assert.deepEqual(annotations, [1, 3]);
    assert.deepEqual(fetched, [3]);
    assert.equal(h.store.candidate(1)?.status, 'ready');
    assert.equal(h.store.candidate(2)?.status, 'failed');
    assert.equal(h.store.candidate(3)?.status, 'ready');
    await backfill.step();
    assert.deepEqual(annotations, [1, 3, 2]);
    assert.deepEqual(fetched, [3]);
  } finally {
    h.cleanup();
  }
});

test('a model-rejected cached page is fetched again after the retry deadline and becomes readable', async () => {
  const h = harness();
  let fetches = 0;
  let annotations = 0;
  const warnings: { event: string; code?: unknown }[] = [];
  const rejectedSource = {
    ...source,
    text: 'Home Products Pricing Careers Contact About the company. '.repeat(12),
  };
  try {
    h.store.saveCandidate(candidate(1));
    h.store.saveSource(1, rejectedSource);
    h.store.saveSource(2, source);
    const assistant = new OpenRouterReadingAssistant(
      { OPENROUTER_API_KEY: 'offline-fixture', OPENROUTER_MODEL: 'offline-fixture' },
      {
        request: async (_url, _service, init) => {
          annotations++;
          const request = JSON.parse(String(init?.body));
          const input = JSON.parse(request.messages[1].content);
          assert.equal(
            input.articles[0].text,
            annotations === 1 ? rejectedSource.text : source.text,
          );
          return {
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: JSON.stringify({
                    articles: [
                      {
                        id: 1,
                        title: '数据库实现',
                        description: '作者介绍了具体的数据库实现与性能测量。',
                        topics: ['架构'],
                        readable: annotations > 1,
                      },
                    ],
                  }),
                },
              },
            ],
          };
        },
      },
    );
    const backfill = new ReadingBackfill(
      h.store,
      h.http,
      {
        extract: async () => {
          fetches++;
          return source;
        },
      },
      assistant,
      100,
      { ...silentLogger, warn: (event, fields) => warnings.push({ event, ...fields }) },
      1,
      h.now,
    );
    await backfill.step();
    assert.equal(h.store.source(1), null);
    assert.deepEqual(h.store.source(2), source);
    assert.equal(h.store.candidate(1)?.status, 'failed');
    assert.deepEqual(warnings, [
      { event: 'reading_annotation_failed', storyId: 1, code: 'reading_source_unreadable' },
    ]);
    h.advance(SIX_HOURS - 1);
    await backfill.step();
    assert.equal(fetches, 0);
    assert.equal(annotations, 1);
    h.advance(1);
    await backfill.step();
    assert.equal(fetches, 1);
    assert.equal(annotations, 2);
    assert.equal(h.store.candidate(1)?.status, 'ready');
    assert.equal(h.store.article(1)?.title, '数据库实现');
    assert.equal(h.store.article(1)?.evidence, 'fulltext');
    assert.deepEqual(h.store.source(1), source);
  } finally {
    h.cleanup();
  }
});

for (const [name, firstResponse] of [
  ['temporary HTTP failure', new RemoteHttpError('openrouter', 503)],
  ['temporary transport failure', new Error('Offline transport failed')],
  ['truncated output', { choices: [{ finish_reason: 'length', message: { content: '' } }] }],
  ['invalid JSON', { choices: [{ finish_reason: 'stop', message: { content: '{broken' } }] }],
  [
    'invalid annotation schema',
    { choices: [{ finish_reason: 'stop', message: { content: '{}' } }] },
  ],
] as const) {
  test(`archive ${name} preserves the source for the next annotation retry`, async () => {
    const h = harness();
    let annotations = 0;
    let fetches = 0;
    try {
      h.store.saveCandidate(candidate(1));
      h.store.saveSource(1, source);
      const assistant = new OpenRouterReadingAssistant(
        { OPENROUTER_API_KEY: 'offline-fixture', OPENROUTER_MODEL: 'offline-fixture' },
        {
          request: async () => {
            annotations++;
            if (annotations === 1) {
              if (firstResponse instanceof Error) throw firstResponse;
              return firstResponse;
            }
            return {
              choices: [
                {
                  finish_reason: 'stop',
                  message: {
                    content: JSON.stringify({
                      articles: [
                        {
                          id: 1,
                          title: '数据库实现',
                          description: '作者介绍了数据库实现。',
                          topics: ['架构'],
                          readable: true,
                        },
                      ],
                    }),
                  },
                },
              ],
            };
          },
        },
      );
      const backfill = new ReadingBackfill(
        h.store,
        h.http,
        {
          extract: async () => {
            fetches++;
            return source;
          },
        },
        assistant,
        100,
        silentLogger,
        1,
        h.now,
      );
      await backfill.step();
      assert.equal(h.store.candidate(1)?.status, 'failed');
      assert.deepEqual(h.store.source(1), source);
      assert.equal(h.store.article(1), null);
      h.advance(SIX_HOURS);
      await backfill.step();
      assert.equal(annotations, 2);
      assert.equal(fetches, 0);
      assert.equal(h.store.candidate(1)?.status, 'ready');
      assert.equal(h.store.article(1)?.title, '数据库实现');
      assert.deepEqual(h.store.source(1), source);
    } finally {
      h.cleanup();
    }
  });
}

test('idle archive runs back off and inventory diagnostics only repeat on changes or hourly heartbeat', async () => {
  const h = harness();
  const delays: number[] = [];
  const inventories: unknown[] = [];
  let signalPaused = () => {};
  const paused = new Promise<void>((resolve) => {
    signalPaused = resolve;
  });
  const backfill = new ReadingBackfill(
    h.store,
    h.http,
    {
      extract: async () => {
        throw new Error('A source in backoff must not be fetched');
      },
    },
    h.assistant,
    100,
    {
      ...silentLogger,
      info: (event, fields) => {
        if (event === 'reading_inventory') inventories.push(fields);
      },
    },
    1,
    h.now,
    async (milliseconds) => {
      delays.push(milliseconds);
      signalPaused();
      throw new Error('End the test run');
    },
  );
  try {
    h.store.saveCandidate(candidate(1, { status: 'failed', attemptedAt: h.now() }));
    await backfill.step();
    await backfill.step();
    assert.equal(inventories.length, 1);
    h.advance(3_600_000);
    await backfill.step();
    assert.equal(inventories.length, 2);
    h.store.saveCandidate(candidate(2, { topics: [] }));
    await backfill.step();
    assert.equal(inventories.length, 3);
    backfill.start();
    await Promise.race([paused, delay(50)]);
    assert.deepEqual(delays, [60_000]);
  } finally {
    await backfill.stop();
    h.cleanup();
  }
});

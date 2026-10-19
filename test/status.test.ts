import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReadingBackfill } from '../src/recommendations/backfill.js';
import { operationsPanel } from '../src/recommendations/status.js';
import { ReadingStore } from '../src/recommendations/store.js';
import { silentLogger } from '../src/logger.js';
import { createHarness, draft, story } from './fixtures.js';

test('article recovery reports its own active story instead of the preceding publishing stage', async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = createHarness({
    extractArticle: async () => ({ source: 'unavailable', text: '', readingMinutes: null }),
    summarize: async (_story, article) => ({ ...draft, article }),
  });
  let running: Promise<unknown> | undefined;
  try {
    await h.service.publish(story.id);
    h.runtime.advance(600_000);
    h.dependencies.getTopStories = async () => [];
    h.dependencies.extractArticle = async () => {
      await gate;
      return draft.article;
    };
    running = h.service.runCycle();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(h.service.currentWork(), { stage: '恢复缺失正文', storyId: story.id });
  } finally {
    release();
    await running;
    h.cleanup();
  }
});

test('status panel reads persisted publishing and archive counts, escaping titles and showing retry limits', async () => {
  const h = createHarness();
  const store = new ReadingStore(h.directory);
  const archive = new ReadingBackfill(
    store,
    {
      request: async () => {
        throw new Error('Status must not fetch');
      },
    },
    {
      extract: async () => {
        throw new Error('Status must not extract');
      },
    },
    {
      annotate: async () => {
        throw new Error('Status must not spend model credits');
      },
      understand: async () => {
        throw new Error('Not used');
      },
      explain: async () => {
        throw new Error('Not used');
      },
    },
    100,
    silentLogger,
  );
  try {
    await h.service.runCycle();
    h.repository.recordFailure(story.id, 'summary_output_truncated', h.runtime.now());
    store.put('archive:state', { month: 22, anchor: h.runtime.now(), lastStep: null });
    store.saveCandidate({
      id: 1,
      title: 'Archive',
      url: 'https://example.com',
      score: 200,
      comments: 10,
      time: 100,
      topics: ['架构'],
      status: 'ready',
      attemptedAt: h.runtime.now(),
    });
    const panel = operationsPanel(h.service, archive, 'overview', h.runtime.now());
    assert.match(panel.text, /新发布 1 · 更新 1 · 失败 0/);
    assert.match(panel.text, /已发布 1 · 待发布 0/);
    assert.match(panel.text, /当前失败 1/);
    assert.match(panel.text, /22\/60 个月 · 1 篇候选/);
    assert.match(panel.text, /历史解析 1\/300/);
    assert.match(panel.text, /中文 &amp; &lt;标题&gt;/);
    assert.deepEqual(
      panel.reply_markup.inline_keyboard[0]?.map((b) => b.callback_data),
      ['ops:overview', 'ops:failures'],
    );
    const failed = operationsPanel(h.service, archive, 'failures', h.runtime.now());
    assert.match(failed.text, /summary_output_truncated/);
    assert.match(failed.text, /尝试 1 次/);
    assert.match(failed.text, /未发布文章仍须在 HN Top 30/);
    assert.ok(failed.text.length < 4096);
  } finally {
    store.close();
    h.cleanup();
  }
});

test('active summary progress is visible and cleared on success and failure', async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = createHarness({
    summarize: async () => {
      await gate;
      throw new Error('summary failed');
    },
  });
  try {
    const running = h.service.runCycle();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(h.service.currentWork(), { stage: '生成中文摘要', storyId: story.id });
    assert.match(operationsPanel(h.service, null, 'overview').text, /生成中文摘要 · HN 123/);
    release();
    assert.equal((await running).failed, 1);
    assert.equal(h.service.currentWork(), null);
    assert.equal(h.service.isRunning, false);
    h.dependencies.summarize = async () => {
      throw new Error('Not reached');
    };
    h.dependencies.getTopStories = async () => [];
    await h.service.runCycle();
    assert.equal(h.service.currentWork(), null);
    h.dependencies.getTopStories = async () => {
      throw new Error('HN unavailable');
    };
    await assert.rejects(h.service.runCycle(), /HN unavailable/);
    assert.equal(h.service.currentWork(), null);
    assert.equal(h.service.isRunning, false);
  } finally {
    release();
    h.cleanup();
  }
});

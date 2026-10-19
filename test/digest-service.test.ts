import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { hashComments } from '../src/adapters/hacker-news.js';
import { DigestService } from '../src/application/digest-service.js';
import type {
  Article,
  Comment,
  Draft,
  HackerNewsItem,
  Publication,
  TagFrequency,
} from '../src/domain.js';
import { readyPublication } from '../src/domain.js';
import {
  ApplicationError,
  ConcurrentRunError,
  DeliveryRejectedError,
  PublicationConflictError,
} from '../src/errors.js';
import { silentLogger } from '../src/logger.js';
import { telegramMessageHash } from '../src/presentation.js';
import { SqlitePublicationRepository } from '../src/storage/sqlite-publication-repository.js';
import { config, createHarness, draft, story, summary } from './fixtures.js';

test('truncated summaries are recorded and retried after backoff without publishing partial content', async () => {
  let calls = 0;
  const harness = createHarness({
    summarize: async () => {
      calls++;
      if (calls === 1)
        throw new ApplicationError(
          'summary_output_truncated',
          502,
          'Summary exceeded output limit',
        );
      return structuredClone(draft);
    },
  });
  try {
    assert.equal((await harness.service.runCycle()).failed, 1);
    assert.equal(harness.sends(), 0);
    assert.equal(harness.repository.getPublication(story.id), null);
    assert.equal(harness.service.failures()[0]?.code, 'summary_output_truncated');
    await harness.service.runCycle();
    assert.equal(calls, 1);
    harness.runtime.advance(600_000);
    assert.equal((await harness.service.runCycle()).published, 1);
    assert.equal(harness.sends(), 1);
    assert.equal(harness.service.failures().length, 0);
  } finally {
    harness.cleanup();
  }
});

test('published stories remain deduplicated after the database is reopened', async () => {
  const harness = createHarness();
  let reopened: SqlitePublicationRepository | null = null;
  try {
    const first = await harness.service.publish(story.id);
    assert.equal(first.state, 'published');
    assert.equal(first.messageId, 42);
    harness.repository.close();

    reopened = new SqlitePublicationRepository(harness.directory);
    const service = new DigestService(
      config,
      reopened,
      harness.dependencies,
      silentLogger,
      harness.runtime,
    );
    const second = await service.publish(story.id);
    assert.equal(second.messageId, 42);
    assert.equal(harness.sends(), 1);
  } finally {
    reopened?.close();
    rmSync(harness.directory, { recursive: true });
  }
});

test('definite Telegram rejections retry the saved Telegraph page', async () => {
  let pageCalls = 0;
  let sendCalls = 0;
  const harness = createHarness({
    savePage: async (_generatedDraft, existing) => {
      pageCalls += 1;
      return existing ?? { path: 'saved', url: 'https://telegra.ph/saved' };
    },
    sendMessage: async () => {
      sendCalls += 1;
      if (sendCalls === 1) throw new DeliveryRejectedError('rate limited');
      return 43;
    },
  });

  try {
    await assert.rejects(harness.service.publish(story.id), DeliveryRejectedError);
    assert.equal(harness.repository.getPublication(story.id)?.state, 'ready');

    const publication = await harness.service.publish(story.id);
    assert.equal(publication.state, 'published');
    assert.equal(pageCalls, 1);
    assert.equal(sendCalls, 2);
  } finally {
    harness.cleanup();
  }
});

test('ambiguous Telegram outcomes are never sent again automatically', async () => {
  let sendCalls = 0;
  const harness = createHarness({
    sendMessage: async () => {
      sendCalls += 1;
      throw new Error('connection reset');
    },
  });

  try {
    await assert.rejects(harness.service.publish(story.id));
    assert.equal(harness.repository.getPublication(story.id)?.state, 'uncertain');
    await assert.rejects(harness.service.publish(story.id), PublicationConflictError);
    await harness.service.runCycle();
    assert.equal(sendCalls, 1);
  } finally {
    harness.cleanup();
  }
});

test('interrupted sending records become uncertain before new work starts', async () => {
  const harness = createHarness();
  try {
    harness.repository.savePublication({
      ...readyPublication(draft, harness.runtime.now()),
      state: 'sending',
      page: { path: 'existing', url: 'https://telegra.ph/existing' },
    });
    await assert.rejects(harness.service.publish(story.id), PublicationConflictError);
    assert.equal(harness.repository.getPublication(story.id)?.state, 'uncertain');
    assert.equal(harness.sends(), 0);
  } finally {
    harness.cleanup();
  }
});

test('moderate comment growth refreshes discussion without republishing', async () => {
  let currentStory = { ...story, descendants: 79 };
  let summaries = 0;
  let editedPage = '';
  let editedMessage = 0;
  const comments = [
    ...draft.comments,
    { id: 125, parent: 124, author: 'bob', text: 'Counterpoint' },
  ];
  const harness = createHarness({
    getTopStories: async () => [currentStory],
    collectComments: async () => (summaries === 0 ? draft.comments : comments),
    summarize: async (_story, article, suppliedComments) => {
      summaries += 1;
      return {
        ...structuredClone(draft),
        story: currentStory,
        article,
        comments: suppliedComments,
        commentCount: currentStory.descendants ?? 0,
        commentHash: hashComments(suppliedComments),
      };
    },
    savePage: async (_generatedDraft, existing) => {
      if (existing) editedPage = existing.path;
      return existing ?? { path: 'same-page', url: 'https://telegra.ph/same-page' };
    },
    editMessage: async (_generatedDraft, _page, messageId) => {
      editedMessage = messageId;
    },
  });

  try {
    await harness.service.publish(story.id);
    harness.runtime.advance(2 * 3_600_000);
    currentStory = { ...story, descendants: 93, score: 250 };

    const result = await harness.service.runCycle();
    assert.equal(result.updated, 1);
    assert.equal(editedPage, 'same-page');
    assert.equal(editedMessage, 42);
    assert.equal(harness.sends(), 1);
    assert.equal(harness.repository.getPublication(story.id)?.draft.commentCount, 93);
  } finally {
    harness.cleanup();
  }
});

test('twenty percent comment growth refreshes smaller discussions', async () => {
  let currentStory = { ...story, descendants: 20 };
  let summaries = 0;
  const harness = createHarness({
    getTopStories: async () => [currentStory],
    summarize: async (_story, article, comments) => {
      summaries += 1;
      return {
        ...structuredClone(draft),
        story: currentStory,
        article,
        comments,
        commentCount: currentStory.descendants ?? 0,
        commentHash: `${summaries}`,
      };
    },
  });

  try {
    await harness.service.publish(story.id);
    harness.runtime.advance(2 * 3_600_000);
    currentStory = { ...story, descendants: 24 };

    await harness.service.runCycle();
    assert.equal(summaries, 2);
    assert.equal(harness.repository.getPublication(story.id)?.draft.commentCount, 24);
  } finally {
    harness.cleanup();
  }
});

test('unsettled comments receive a final refresh after twelve hours', async () => {
  let currentStory = story;
  let summaries = 0;
  const harness = createHarness({
    getTopStories: async () => [currentStory],
    summarize: async (_story, article, comments) => {
      summaries += 1;
      return {
        ...structuredClone(draft),
        story: currentStory,
        article,
        comments,
        commentCount: currentStory.descendants ?? 0,
        commentHash: `${summaries}`,
      };
    },
  });

  try {
    await harness.service.publish(story.id);
    harness.runtime.advance(13 * 3_600_000);
    currentStory = { ...story, descendants: 11 };

    await harness.service.runCycle();
    assert.equal(summaries, 2);
    assert.equal(harness.repository.getPublication(story.id)?.draft.commentCount, 11);
  } finally {
    harness.cleanup();
  }
});

test('previews persist drafts without creating public pages or messages', async () => {
  let pageCalls = 0;
  const harness = createHarness({
    savePage: async () => {
      pageCalls += 1;
      throw new Error('must not run');
    },
  });

  try {
    await harness.service.preview(story.id);
    assert.equal(pageCalls, 0);
    assert.equal(harness.sends(), 0);
    assert.equal(harness.repository.getPublication(story.id)?.state, 'ready');
  } finally {
    harness.cleanup();
  }
});

test('summary generation receives searchable historical tags with representative titles', async () => {
  let receivedCatalog: readonly TagFrequency[] = [];
  const harness = createHarness({
    summarize: async (_story, _article, _comments, tagCatalog) => {
      receivedCatalog = tagCatalog;
      return structuredClone(draft);
    },
  });
  const historicalDrafts: Draft[] = [
    {
      ...draft,
      story: { ...story, id: 1 },
      summary: { ...summary, title: 'AI 编程助手', tags: ['AI'] },
    },
    {
      ...draft,
      story: { ...story, id: 2 },
      summary: { ...summary, title: '本地开发工具', tags: ['AI', '开发工具'] },
    },
    {
      ...draft,
      story: { ...story, id: 3 },
      summary: {
        title: '宽泛分类',
        quickTake: '旧摘要结论',
        article: [{ heading: '背景', paragraphs: ['旧正文'] }],
        tags: ['其他', '网络'],
        introduction: '旧摘要导语',
        whyItMatters: ['旧看点一', '旧看点二'],
        discussion: [],
        readIf: '旧字段',
        skipIf: '旧字段',
      },
    },
  ];

  try {
    for (const historicalDraft of historicalDrafts) {
      harness.repository.savePublication(readyPublication(historicalDraft, harness.runtime.now()));
    }
    await harness.service.preview(story.id);
    assert.deepEqual(receivedCatalog, [
      { tag: '开发工具', uses: 1, examples: ['本地开发工具'] },
      { tag: 'AI', uses: 2, examples: ['本地开发工具', 'AI 编程助手'] },
    ]);
  } finally {
    harness.cleanup();
  }
});

test('published drafts cannot be regenerated through preview', async () => {
  const harness = createHarness();
  try {
    await harness.service.publish(story.id);
    await assert.rejects(harness.service.preview(story.id, true), PublicationConflictError);
    assert.equal(harness.repository.getPublication(story.id)?.messageId, 42);
    assert.equal(harness.sends(), 1);
  } finally {
    harness.cleanup();
  }
});

test('concurrent operations are rejected while a delivery owns the lease', async () => {
  let releaseSend: ((messageId: number) => void) | undefined;
  let signalSendStarted: (() => void) | undefined;
  const sendStarted = new Promise<void>((resolve) => {
    signalSendStarted = resolve;
  });
  const harness = createHarness({
    sendMessage: async () => {
      signalSendStarted?.();
      return new Promise<number>((resolve) => {
        releaseSend = resolve;
      });
    },
  });

  try {
    const publishing = harness.service.publish(story.id);
    await sendStarted;
    await assert.rejects(harness.service.preview(story.id), ConcurrentRunError);
    assert.ok(releaseSend);
    releaseSend(42);
    await publishing;
  } finally {
    harness.cleanup();
  }
});

function publicationWithoutArticle(
  id: number,
  now: number,
  url = 'https://blocked.example/article',
): Publication {
  const oldDraft: Draft = {
    ...structuredClone(draft),
    story: { ...story, id, url },
    article: { text: '', source: 'unavailable', readingMinutes: null },
    summary: { ...summary, title: '尚未获取原文', quickTake: '原文暂不可用', article: [] },
  };
  const page = { path: `existing-${id}`, url: `https://telegra.ph/existing-${id}` };
  return {
    ...readyPublication(oldDraft, now - 72 * 3_600_000),
    state: 'published',
    page,
    messageId: id + 1000,
    messageHash: telegramMessageHash(oldDraft, page.url),
    publishedAt: now - 72 * 3_600_000,
    updates: config.MAX_COMMENT_UPDATES,
  };
}

function recoveredDraft(item: HackerNewsItem, article: Article, comments: Comment[]): Draft {
  return {
    ...structuredClone(draft),
    story: item,
    article,
    comments,
    commentHash: hashComments(comments),
    summary: { ...summary, title: '已恢复原文', quickTake: '来自恢复正文的摘要' },
  };
}

test('unavailable articles recover beyond the discussion window using the existing page and message', async () => {
  let extractions = 0;
  let savedPath = '';
  let editedMessage = 0;
  const harness = createHarness({
    getTopStories: async () => [],
    extractArticle: async () => {
      extractions += 1;
      return draft.article;
    },
    collectComments: async () => {
      throw new Error('source recovery must not depend on fetching new comments');
    },
    summarize: async (item, article, comments) => recoveredDraft(item, article, comments),
    savePage: async (_draft, existing) => {
      assert.ok(existing);
      savedPath = existing.path;
      return existing;
    },
    editMessage: async (_draft, _page, messageId) => {
      editedMessage = messageId;
    },
  });
  try {
    const old = publicationWithoutArticle(story.id, harness.runtime.now());
    harness.repository.savePublication(old);
    assert.equal((await harness.service.runCycle()).updated, 1);
    const recovered = harness.repository.getPublication(story.id);
    assert.equal(recovered?.draft.article.source, 'article');
    assert.equal(recovered?.draft.summary.title, '已恢复原文');
    assert.equal(savedPath, old.page?.path);
    assert.equal(editedMessage, old.messageId);
    assert.equal(recovered?.updates, old.updates);
    assert.equal(harness.sends(), 0);
    await harness.service.runCycle();
    assert.equal(extractions, 1);
  } finally {
    harness.cleanup();
  }
});

test('article recovery backoff survives a new service and preserves the previous publication on fetch failure', async () => {
  let extractions = 0;
  const harness = createHarness({
    getTopStories: async () => [],
    extractArticle: async () => {
      extractions += 1;
      return extractions === 1
        ? { text: '', source: 'unavailable', readingMinutes: null }
        : draft.article;
    },
    summarize: async (item, article, comments) => recoveredDraft(item, article, comments),
  });
  let reopened: SqlitePublicationRepository | null = null;
  try {
    const old = publicationWithoutArticle(story.id, harness.runtime.now());
    harness.repository.savePublication(old);
    assert.equal((await harness.service.runCycle()).failed, 1);
    assert.deepEqual(harness.repository.getPublication(story.id), old);
    reopened = new SqlitePublicationRepository(harness.directory);
    const service = new DigestService(
      config,
      reopened,
      harness.dependencies,
      silentLogger,
      harness.runtime,
    );
    await service.runCycle();
    assert.equal(extractions, 1);
    harness.runtime.advance(600_000);
    assert.equal((await service.runCycle()).updated, 1);
    assert.equal(extractions, 2);
    assert.equal(reopened.getPublication(story.id)?.draft.article.source, 'article');
  } finally {
    reopened?.close();
    harness.cleanup();
  }
});

test('article recovery has a per-cycle budget and gives another host a turn', async () => {
  const fetched: number[] = [];
  const harness = createHarness({
    getTopStories: async () => [],
    extractArticle: async (item) => {
      fetched.push(item.id);
      return { text: '', source: 'unavailable', readingMinutes: null };
    },
  });
  try {
    for (const id of [1, 2, 3, 4])
      harness.repository.savePublication(publicationWithoutArticle(id, harness.runtime.now()));
    harness.repository.savePublication(
      publicationWithoutArticle(5, harness.runtime.now(), 'https://other.example/article'),
    );
    const first = await harness.service.runCycle();
    assert.equal(first.failed, 3);
    assert.equal(fetched.length, 3);
    assert.ok(fetched.includes(5));
    await harness.service.runCycle();
    assert.equal(new Set(fetched).size, 5);
    assert.equal(fetched.length, 5);
  } finally {
    harness.cleanup();
  }
});

test('a recovered source is retained when summary generation fails', async () => {
  let extractions = 0;
  let summaries = 0;
  const harness = createHarness({
    getTopStories: async () => [],
    extractArticle: async () => {
      extractions += 1;
      return draft.article;
    },
    summarize: async (item, article, comments) => {
      summaries += 1;
      if (summaries === 1)
        throw new ApplicationError('summary_output_truncated', 502, 'Summary failed');
      return recoveredDraft(item, article, comments);
    },
  });
  try {
    const old = publicationWithoutArticle(story.id, harness.runtime.now());
    harness.repository.savePublication(old);
    assert.equal((await harness.service.runCycle()).failed, 1);
    assert.deepEqual(harness.repository.getPublication(story.id), old);
    harness.runtime.advance(600_000);
    assert.equal((await harness.service.runCycle()).updated, 1);
    assert.equal(extractions, 1);
    assert.equal(summaries, 2);
  } finally {
    harness.cleanup();
  }
});

test('old recovered publications retry a failed Telegram edit without fetching or rebuilding the page', async () => {
  let extractions = 0;
  let pages = 0;
  let edits = 0;
  const harness = createHarness({
    getTopStories: async () => [],
    extractArticle: async () => {
      extractions += 1;
      return draft.article;
    },
    summarize: async (item, article, comments) => recoveredDraft(item, article, comments),
    savePage: async (_draft, existing) => {
      pages += 1;
      assert.ok(existing);
      return existing;
    },
    editMessage: async () => {
      edits += 1;
      if (edits === 1) throw new DeliveryRejectedError('rate limited');
    },
  });
  try {
    const old = publicationWithoutArticle(story.id, harness.runtime.now());
    harness.repository.savePublication(old);
    assert.equal((await harness.service.runCycle()).failed, 1);
    assert.equal(harness.repository.getPublication(story.id)?.draft.article.source, 'article');
    assert.equal(harness.repository.getPublication(story.id)?.messageHash, old.messageHash);
    harness.runtime.advance(600_000);
    assert.equal((await harness.service.runCycle()).updated, 1);
    const recovered = harness.repository.getPublication(story.id);
    assert.ok(recovered?.page);
    assert.equal(recovered.messageHash, telegramMessageHash(recovered.draft, recovered.page.url));
    assert.equal(extractions, 1);
    assert.equal(pages, 1);
    assert.equal(edits, 2);
    assert.equal(harness.sends(), 0);
  } finally {
    harness.cleanup();
  }
});

test('newly published unavailable sources wait for recovery backoff before another fetch', async () => {
  let extractions = 0;
  const harness = createHarness({
    getTopStories: async () => [],
    extractArticle: async () => {
      extractions += 1;
      return extractions === 1
        ? { text: '', source: 'unavailable', readingMinutes: null }
        : draft.article;
    },
    summarize: async (item, article, comments) => ({
      ...recoveredDraft(item, article, comments),
      summary:
        article.source === 'unavailable'
          ? { ...summary, quickTake: '原文暂不可用', article: [] }
          : summary,
    }),
  });
  try {
    await harness.service.publish(story.id);
    await harness.service.runCycle();
    assert.equal(extractions, 1);
    harness.runtime.advance(600_000);
    assert.equal((await harness.service.runCycle()).updated, 1);
    assert.equal(extractions, 2);
    assert.equal(harness.sends(), 1);
  } finally {
    harness.cleanup();
  }
});

test('discussion refresh cannot bypass the backoff for a pending source-recovery message edit', async () => {
  let edits = 0;
  const harness = createHarness({
    getTopStories: async () => [story],
    summarize: async (item, article, comments) => recoveredDraft(item, article, comments),
    editMessage: async () => {
      edits += 1;
      if (edits === 1) throw new DeliveryRejectedError('rate limited');
    },
  });
  try {
    harness.repository.savePublication({
      ...publicationWithoutArticle(story.id, harness.runtime.now()),
      publishedAt: harness.runtime.now() - 3_600_000,
    });
    assert.equal((await harness.service.runCycle()).failed, 1);
    await harness.service.runCycle();
    assert.equal(edits, 1);
    harness.runtime.advance(600_000);
    assert.equal((await harness.service.runCycle()).updated, 1);
    assert.equal(edits, 2);
  } finally {
    harness.cleanup();
  }
});

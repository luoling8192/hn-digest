import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { hashComments } from '../src/adapters/hacker-news.js';
import { DigestService } from '../src/application/digest-service.js';
import type { Draft, TagFrequency } from '../src/domain.js';
import { readyPublication } from '../src/domain.js';
import {
  ConcurrentRunError,
  DeliveryRejectedError,
  PublicationConflictError,
} from '../src/errors.js';
import { silentLogger } from '../src/logger.js';
import { SqlitePublicationRepository } from '../src/storage/sqlite-publication-repository.js';
import { config, createHarness, draft, story, summary } from './fixtures.js';

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

test('comment growth edits the existing page and Telegram message without republishing', async () => {
  let currentStory = story;
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
    currentStory = { ...story, descendants: 80, score: 250 };

    const result = await harness.service.runCycle();
    assert.equal(result.updated, 1);
    assert.equal(editedPage, 'same-page');
    assert.equal(editedMessage, 42);
    assert.equal(harness.sends(), 1);
    assert.equal(harness.repository.getPublication(story.id)?.draft.commentCount, 80);
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

test('summary generation receives reusable historical tags ordered by frequency', async () => {
  let receivedCatalog: readonly TagFrequency[] = [];
  const harness = createHarness({
    summarize: async (_story, _article, _comments, tagCatalog) => {
      receivedCatalog = tagCatalog;
      return structuredClone(draft);
    },
  });
  const historicalDrafts: Draft[] = [
    { ...draft, story: { ...story, id: 1 }, summary: { ...summary, tags: ['AI'] } },
    {
      ...draft,
      story: { ...story, id: 2 },
      summary: { ...summary, tags: ['AI', '开发工具'] },
    },
    {
      ...draft,
      story: { ...story, id: 3 },
      summary: { ...summary, tags: ['其他'], readIf: '旧字段', skipIf: '旧字段' },
    },
  ];

  try {
    for (const historicalDraft of historicalDrafts) {
      harness.repository.savePublication(readyPublication(historicalDraft, harness.runtime.now()));
    }
    await harness.service.preview(story.id);
    assert.deepEqual(receivedCatalog, [
      { tag: 'AI', uses: 2 },
      { tag: '开发工具', uses: 1 },
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

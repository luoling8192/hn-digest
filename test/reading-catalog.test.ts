import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { type Publication, readyPublication } from '../src/domain.js';
import { ReadingCatalog } from '../src/recommendations/catalog.js';
import { newReader } from '../src/recommendations/model.js';
import { recommend } from '../src/recommendations/ranking.js';
import { ReadingService } from '../src/recommendations/service.js';
import { ReadingStore } from '../src/recommendations/store.js';
import { SqlitePublicationRepository } from '../src/storage/sqlite-publication-repository.js';
import { draft } from './fixtures.js';

test('catalog refresh recovers a saved unavailable source and updates later revisions of the same page', async () => {
  const directory = mkdtempSync(join(process.cwd(), 'reading-catalog-test-'));
  const store = new ReadingStore(directory);
  const publications = new SqlitePublicationRepository(directory);
  const publication: Publication = {
    ...readyPublication(
      {
        ...draft,
        article: { source: 'unavailable', text: '', readingMinutes: null },
      },
      1,
    ),
    state: 'published',
    page: { path: 'same-page', url: 'https://telegra.ph/same-page' },
    messageId: 42,
    publishedAt: 1,
  };
  const forbidden = async (): Promise<never> => {
    throw new Error('Channel feedback must not call the model');
  };
  const service = new ReadingService(
    100,
    store,
    { call: async () => ({}) },
    { refresh: forbidden },
    { annotate: forbidden, understand: forbidden, explain: forbidden },
    () => 1000,
    undefined,
    undefined,
    { chatId: '-100123456789', publications },
  );
  const catalog = new ReadingCatalog(store, publications);
  try {
    publications.savePublication(publication);
    await service.handle({
      update_id: 1,
      callback_query: {
        id: 'save-unavailable',
        from: { id: 200, is_bot: false },
        data: `d:save:${draft.story.id}`,
        message: { message_id: 42, chat: { id: -100123456789, type: 'channel' } },
      },
    });
    assert.equal(store.reader(200)?.feedback[draft.story.id]?.saved, true);
    assert.equal(store.article(draft.story.id)?.evidence, 'title');
    assert.deepEqual(store.source(draft.story.id), publication.draft.article);
    await catalog.refresh();
    assert.deepEqual(recommend(newReader(300), store.articles()), []);

    const recovered: Publication = {
      ...publication,
      draft: {
        ...draft,
        story: { ...draft.story, title: 'Database recovery', score: 300 },
        summary: {
          format: 'narrative-v1',
          title: '数据库恢复',
          tags: ['数据库'],
          quickTake: '恢复后的完整摘要。',
          article: [{ heading: '恢复', paragraphs: ['正文已经恢复。'] }],
          discussion: [],
        },
        article: { source: 'article', text: 'Recovered database source', readingMinutes: 8 },
      },
    };
    publications.savePublication(recovered);
    await catalog.refresh();
    assert.deepEqual(store.article(draft.story.id), {
      id: draft.story.id,
      title: '数据库恢复',
      originalTitle: 'Database recovery',
      url: draft.story.url,
      summaryUrl: publication.page?.url,
      description: '恢复后的完整摘要。',
      topics: ['架构', '数据库'],
      score: 300,
      time: draft.story.time,
      minutes: 8,
      evidence: 'summary',
      sourceCharacters: recovered.draft.article.text.length,
      truncated: false,
    });
    assert.deepEqual(store.source(draft.story.id), recovered.draft.article);
    assert.deepEqual(
      recommend(newReader(300), store.articles()).map(({ article }) => article.id),
      [draft.story.id],
    );

    const revised: Publication = {
      ...recovered,
      draft: {
        ...recovered.draft,
        summary: { ...recovered.draft.summary, title: '数据库恢复修订版' },
        article: { source: 'article', text: 'Revised recovered source', readingMinutes: 9 },
      },
    };
    publications.savePublication(revised);
    await catalog.refresh();
    assert.equal(store.article(draft.story.id)?.summaryUrl, publication.page?.url);
    assert.equal(store.article(draft.story.id)?.title, '数据库恢复修订版');
    assert.equal(store.article(draft.story.id)?.minutes, 9);
    assert.deepEqual(store.source(draft.story.id), revised.draft.article);
    assert.equal(store.reader(200)?.feedback[draft.story.id]?.saved, true);
  } finally {
    publications.close();
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test('public saved views refresh only their canonical page articles without catalog or model access', async () => {
  const directory = mkdtempSync(join(process.cwd(), 'reading-catalog-test-'));
  const store = new ReadingStore(directory);
  const publications = new SqlitePublicationRepository(directory);
  const publication: Publication = {
    ...readyPublication(
      { ...draft, article: { source: 'unavailable', text: '', readingMinutes: null } },
      1,
    ),
    state: 'published',
    page: { path: 'public-same-page', url: 'https://telegra.ph/public-same-page' },
    messageId: 42,
    publishedAt: 1,
  };
  const sent: string[] = [];
  const lookups: number[] = [];
  const forbidden = async (): Promise<never> => {
    throw new Error('Public saved views must not call the catalog or model');
  };
  const service = new ReadingService(
    100,
    store,
    {
      call: async (method, payload) => {
        if (method === 'sendMessage') sent.push(String((payload as { text: string }).text));
        return { message_id: 100 };
      },
    },
    { refresh: forbidden },
    { annotate: forbidden, understand: forbidden, explain: forbidden },
    () => 1000,
    undefined,
    undefined,
    {
      chatId: '-100123456789',
      publications: {
        listPublications: () => publications.listPublications(),
        getPublication: (id) => {
          lookups.push(id);
          return publications.getPublication(id);
        },
      },
    },
  );
  try {
    publications.savePublication(publication);
    await service.handle({
      update_id: 1,
      callback_query: {
        id: 'public-save-unavailable',
        from: { id: 200, is_bot: false },
        data: `d:save:${draft.story.id}`,
        message: { message_id: 42, chat: { id: -100123456789, type: 'channel' } },
      },
    });
    const savedArticle = store.article(draft.story.id);
    assert.ok(savedArticle);
    const archived = { ...savedArticle, id: 999, title: '归档收藏' };
    store.saveArticle(archived);
    const reader = store.reader(200);
    assert.ok(reader);
    reader.feedback[999] = { saved: true, opinion: 0, revision: 1, savedAt: 1001 };
    store.saveReader(reader);

    const recovered: Publication = {
      ...publication,
      draft: {
        ...draft,
        summary: { ...draft.summary, title: '恢复后的标题', quickTake: '恢复后的摘要。' },
        article: {
          source: 'article',
          text: 'Recovered source for a public reader',
          readingMinutes: 8,
        },
      },
    };
    publications.savePublication(recovered);
    lookups.length = 0;
    await service.handle({
      update_id: 2,
      message: {
        message_id: 2,
        from: { id: 200, is_bot: false },
        chat: { id: 200, type: 'private' },
        text: '/saved',
      },
    });
    assert.match(sent.at(-1) ?? '', /恢复后的标题/);
    assert.match(sent.at(-1) ?? '', /恢复后的摘要。/);
    assert.match(sent.at(-1) ?? '', /约 8 分钟/);
    assert.deepEqual(store.source(draft.story.id), recovered.draft.article);
    assert.equal(store.article(draft.story.id)?.evidence, 'summary');
    assert.deepEqual(store.article(999), archived);
    assert.deepEqual(
      lookups.sort((one, two) => one - two),
      [draft.story.id, 999],
    );
    assert.equal(store.reader(200)?.feedback[draft.story.id]?.saved, true);
    assert.equal(service.accessStatus().enabledReaders, 1);
  } finally {
    publications.close();
    store.close();
    rmSync(directory, { recursive: true });
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Batch, newReader, type ReadingArticle } from '../src/recommendations/model.js';
import { type ReadingMessage, renderBatch } from '../src/recommendations/presentation.js';

const articles: ReadingArticle[] = [
  {
    id: 41,
    title: '数据库文章',
    originalTitle: 'Database article',
    url: 'https://example.com/database',
    summaryUrl: 'https://telegra.ph/database',
    description: '数据库实践',
    topics: ['数据库'],
    score: 120,
    time: 1600000000,
    minutes: 8,
    evidence: 'summary',
  },
  {
    id: 42,
    title: '架构文章',
    originalTitle: 'Architecture article',
    url: 'https://example.com/architecture?a=1&b=2',
    summaryUrl: null,
    description: '架构实践',
    topics: ['架构'],
    score: 80,
    time: 1600000000,
    minutes: null,
    evidence: 'fulltext',
  },
];

function batch(changes: Partial<Batch> = {}): Batch {
  return {
    id: 'public-batch',
    userId: 200,
    messageId: 10,
    articleIds: [41, 42],
    selected: [],
    reasons: { 41: '符合你的兴趣', 42: '你可能感兴趣' },
    kind: 'recommendations',
    page: 0,
    createdAt: 1000,
    notice: '',
    undo: [],
    ...changes,
  };
}

function actions(message: ReadingMessage): string[] {
  return message.reply_markup.inline_keyboard
    .flat()
    .map((button) => button.callback_data.split(':').slice(2).join(':'));
}

test('public recommendations offer another batch and personal saved list without AI controls', () => {
  const message = renderBatch(batch(), newReader(200), articles, true, false);
  assert.deepEqual(actions(message), ['select:1', 'select:2', 'more', 'saved']);
  assert.match(message.text, /为你挑了 2 篇/);
  assert.doesNotMatch(message.text, /聊聊|调整方向/);
});

test('public article selection supports personal feedback and undo while AI access is revoked', () => {
  const selected = batch({
    selected: [41],
    undo: [
      {
        id: 42,
        before: { saved: false, opinion: 0, revision: 0, savedAt: 0 },
        revision: 1,
      },
    ],
  });
  const publicMessage = renderBatch(selected, newReader(200), articles, true, false);
  assert.deepEqual(actions(publicMessage), [
    'select:1',
    'select:2',
    'save',
    'like',
    'less',
    'clear',
    'undo',
  ]);
  assert.equal(publicMessage.reply_markup.inline_keyboard[0]?.[0]?.text, '✓ 1');
  const authorizedMessage = renderBatch(selected, newReader(200), articles, true, true);
  assert.equal(actions(authorizedMessage).includes('explain'), true);
  assert.equal(actions(publicMessage).includes('explain'), false);
});

test('public saved pages retain paging and recommendation entry and allow removal after selection', () => {
  const saved = batch({ kind: 'saved', page: 1 });
  assert.deepEqual(actions(renderBatch(saved, newReader(200), articles, true, false)), [
    'select:1',
    'select:2',
    'prev',
    'next',
    'more',
  ]);
  const selected = renderBatch({ ...saved, selected: [41] }, newReader(200), articles, true, false);
  assert.deepEqual(actions(selected), [
    'select:1',
    'select:2',
    'save',
    'like',
    'less',
    'clear',
    'unsave',
  ]);
});

test('recommendation links reuse Chinese pages and otherwise open original source with reader-specific saves', () => {
  const reader = newReader(200);
  reader.feedback[41] = { saved: true, opinion: 0, revision: 1, savedAt: 500 };
  const message = renderBatch(batch(), reader, articles, true, false);
  assert.match(message.text, /href="https:\/\/telegra\.ph\/database">数据库文章<\/a> ⭐/);
  assert.match(
    message.text,
    /href="https:\/\/example\.com\/architecture\?a=1&amp;b=2">架构文章<\/a>\n/,
  );
  assert.doesNotMatch(renderBatch(batch(), newReader(201), articles, true, false).text, /⭐/);
  assert.equal(message.link_preview_options.is_disabled, true);
});

test('default rendering retains authorized AI controls and legacy saved-only rendering stays restricted', () => {
  assert.deepEqual(actions(renderBatch(batch(), newReader(200), articles)), [
    'select:1',
    'select:2',
    'more',
    'preferences',
    'saved',
  ]);
  const saved = batch({ kind: 'saved', selected: [42] });
  assert.deepEqual(actions(renderBatch(saved, newReader(200), articles, false)), [
    'select:1',
    'select:2',
    'unsave',
    'clear',
  ]);
});

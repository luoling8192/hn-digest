import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Draft } from '../src/domain.js';
import { publicationSchema, summarySchema } from '../src/domain.js';
import { readyPublication } from '../src/domain.js';
import { renderTelegramMessage, renderTelegraphPage } from '../src/presentation.js';
import { draft } from './fixtures.js';

test('renders separate article and discussion sections with direct comment references', () => {
  const content = JSON.stringify(renderTelegraphPage(draft));
  assert.match(content, /15 秒版/);
  assert.match(content, /看点/);
  assert.match(content, /一句话 <结论>/);
  assert.match(content, /解决具体问题/);
  assert.match(content, /原文摘要/);
  assert.match(content, /HN 讨论摘要/);
  assert.match(content, /item\?id=124/);

  const message = renderTelegramMessage(draft, 'https://telegra.ph/test');
  assert.match(message.text, /#AI #编程语言/);
  assert.match(message.text, /一句话 &lt;结论&gt;/);
  assert.match(message.text, /&amp; &lt;标题&gt;/);
  assert.match(message.text, /3 分钟 · 200 分 · 10 评论/);
  assert.doesNotMatch(message.text, /15 秒版|看点|解决具体问题|适合你|可以跳过|原文：/);
  assert.ok(message.text.length < 4_096);
  assert.equal(message.link_preview_options.url, 'https://telegra.ph/test');
  assert.equal(message.reply_markup.inline_keyboard[0]?.[1]?.text, '评论：10');
});

test('accepts optional retrieval tags and rejects malformed or broad categories', () => {
  assert.equal(summarySchema.safeParse(draft.summary).success, true);
  assert.equal(summarySchema.safeParse({ ...draft.summary, tags: [] }).success, true);
  assert.equal(summarySchema.safeParse({ ...draft.summary, tags: ['机器人'] }).success, true);
  assert.equal(summarySchema.safeParse({ ...draft.summary, tags: ['AI', '数据库'] }).success, true);
  assert.equal(summarySchema.safeParse({ ...draft.summary, tags: ['其他'] }).success, false);
  assert.equal(summarySchema.safeParse({ ...draft.summary, tags: ['网络'] }).success, false);
  assert.equal(summarySchema.safeParse({ ...draft.summary, tags: ['亚文化'] }).success, false);
  assert.equal(summarySchema.safeParse({ ...draft.summary, tags: ['AI 工具'] }).success, false);
  assert.equal(summarySchema.safeParse({ ...draft.summary, tags: ['#AI'] }).success, false);
  assert.equal(
    summarySchema.safeParse({ ...draft.summary, tags: ['AI', '数据库', '开源'] }).success,
    false,
  );
});

test('renders scan cards without forcing a tag', () => {
  const untagged: Draft = {
    ...draft,
    summary: { ...draft.summary, tags: [] },
  };

  const message = renderTelegramMessage(untagged, 'https://telegra.ph/untagged');
  assert.ok(message.text.startsWith('<a href='));
  assert.doesNotMatch(message.text, /^#/);
  assert.match(message.text, /一句话 &lt;结论&gt;/);
});

test('keeps legacy persisted summaries readable and deliverable', () => {
  const legacyDraft: Draft = {
    ...draft,
    summary: {
      title: '旧摘要',
      introduction: '旧导语',
      article: [{ heading: '原文', paragraphs: ['完整摘要'] }],
      discussion: [],
    },
  };
  const persisted = readyPublication(legacyDraft, 1);

  assert.equal(publicationSchema.safeParse(persisted).success, true);
  assert.doesNotMatch(
    renderTelegramMessage(legacyDraft, 'https://telegra.ph/legacy').text,
    /15 秒版/,
  );
  assert.match(JSON.stringify(renderTelegraphPage(legacyDraft)), /完整摘要/);
});

test('previous scan cards with suitability fields remain readable without rendering those fields', () => {
  const persisted = publicationSchema.parse({
    ...readyPublication(draft, 1),
    draft: {
      ...draft,
      summary: {
        ...draft.summary,
        tags: ['其他', '网络', 'AI', '编程语言'],
        readIf: '关注 AI 编程',
        skipIf: '只需要成熟工具',
      },
    },
  });

  const message = renderTelegramMessage(persisted.draft, 'https://telegra.ph/previous-card');
  assert.match(message.text, /#AI #编程语言/);
  assert.doesNotMatch(message.text, /#其他|#网络|关注 AI 编程|只需要成熟工具|适合你|可以跳过/);
});

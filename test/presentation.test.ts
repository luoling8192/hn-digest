import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Draft } from '../src/domain.js';
import { publicationSchema, summarySchema } from '../src/domain.js';
import { readyPublication } from '../src/domain.js';
import { renderTelegramMessage, renderTelegraphPage } from '../src/presentation.js';
import { draft } from './fixtures.js';

test('renders separate article and discussion sections with direct comment references', () => {
  const content = JSON.stringify(renderTelegraphPage(draft));
  assert.match(content, /原文摘要/);
  assert.match(content, /HN 讨论摘要/);
  assert.match(content, /item\?id=124/);

  const message = renderTelegramMessage(draft, 'https://telegra.ph/test');
  assert.match(message.text, /#AI #编程语言/);
  assert.match(message.text, /15 秒版/);
  assert.match(message.text, /一句话 &lt;结论&gt;/);
  assert.match(message.text, /&amp; &lt;标题&gt;/);
  assert.ok(message.text.length < 4_096);
  assert.equal(message.link_preview_options.url, 'https://telegra.ph/test');
  assert.equal(message.reply_markup.inline_keyboard[0]?.[1]?.text, '评论：10');
});

test('accepts only the controlled topic taxonomy', () => {
  assert.equal(summarySchema.safeParse(draft.summary).success, true);
  assert.equal(
    summarySchema.safeParse({ ...draft.summary, tags: ['随便写的标签', 'AI'] }).success,
    false,
  );
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

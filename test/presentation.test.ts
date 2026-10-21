import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { Draft } from '../src/domain.js';
import { publicationSchema, readyPublication, summarySchema } from '../src/domain.js';
import {
  renderTelegramDelivery,
  renderTelegramMessage,
  renderTelegraphPage,
  telegramMessageHash,
} from '../src/presentation.js';
import { draft, summary } from './fixtures.js';

function parsedTextLength(html: string): number {
  const text = new JSDOM(html).window.document.body.textContent;
  assert.ok(text !== null);
  return text.length;
}

test('source and reading time use explicit labels on separate lines', () => {
  const url = 'https://www.righto.com/article?one=1&two=2';
  const message = renderTelegramMessage(
    { ...draft, story: { ...draft.story, url } },
    'https://telegra.ph/chinese-rewrite',
  );
  const document = new JSDOM(message.text).window.document;
  const source = [...document.querySelectorAll('a')].find((node) => node.textContent === url);
  assert.ok(source);
  assert.equal(source.href, url);
  assert.equal(source.textContent, url);
  assert.equal(document.querySelector('b > a')?.getAttribute('href'), url);
  const footer = new JSDOM(message.text.split('</blockquote>')[1]).window.document;
  assert.equal(
    footer.body.textContent,
    `🔗 原文：${url}\n⏱️ 阅读时间：约 3 分钟\n💬 HN 讨论 · 10 条\n\n#AI #编程语言`,
  );
  assert.equal(message.link_preview_options.url, 'https://telegra.ph/chinese-rewrite');
  assert.equal('reply_markup' in message, false);
});

test('channel feedback adds only callbacks while reading remains in the native preview', () => {
  const plain = renderTelegramMessage(draft, 'https://telegra.ph/test');
  const interactive = renderTelegramMessage(draft, 'https://telegra.ph/test', true);
  assert.equal(interactive.text, plain.text);
  assert.equal('reply_markup' in plain, false);
  assert.deepEqual(interactive.reply_markup?.inline_keyboard, [
    [
      { text: '♡ 喜欢', callback_data: 'd:like:123' },
      { text: '☆ 收藏', callback_data: 'd:save:123' },
    ],
  ]);
  const pictured: Draft = {
    ...draft,
    article: {
      ...draft.article,
      media: { coverImage: 'https://example.com/cover.jpg', images: [] },
    },
  };
  const planned = renderTelegramDelivery(pictured, 'https://telegra.ph/test', true);
  assert.equal(planned.kind, 'text');
  assert.deepEqual(planned.payload.reply_markup, interactive.reply_markup);
  assert.notEqual(
    telegramMessageHash(draft, 'https://telegra.ph/test'),
    telegramMessageHash(draft, 'https://telegra.ph/test', true),
  );
});

test('renders separate article and discussion sections with direct comment references', () => {
  const nodes = renderTelegraphPage(draft);
  const content = JSON.stringify(nodes);
  assert.deepEqual(nodes.slice(0, 2), [
    {
      tag: 'p',
      children: [
        '原标题：',
        { tag: 'a', attrs: { href: 'https://example.com/article' }, children: ['A & B < C'] },
      ],
    },
    { tag: 'p', children: ['一句话 <结论>'] },
  ]);
  assert.doesNotMatch(content, /15 秒版|看点|相关评论：/);
  assert.match(content, /一句话 <结论>/);
  assert.match(content, /原文摘要/);
  assert.match(content, /HN 讨论综述/);
  assert.match(content, /item\?id=124/);

  const message = renderTelegramMessage(draft, 'https://telegra.ph/test');
  assert.match(message.text, /#AI #编程语言/);
  assert.doesNotMatch(message.text, /一句话 &lt;结论&gt;/);
  assert.match(message.text, /&amp; &lt;标题&gt;/);
  assert.match(message.text, /（★ 200 分）/);
  assert.match(message.text, />💬 HN 讨论 · 10 条<\/a>/);
  assert.match(message.text, /<\/a>\n⏱️ 阅读时间：约 3 分钟/);
  assert.doesNotMatch(message.text, /HN 200 分/);
  assert.doesNotMatch(message.text, /10 评论/);
  assert.doesNotMatch(message.text, /15 秒版|看点|解决具体问题|适合你|可以跳过/);
  assert.ok(message.text.length < 4_096);
  assert.equal(message.link_preview_options.is_disabled, false);
  assert.equal(message.link_preview_options.url, 'https://telegra.ph/test');
  assert.equal('reply_markup' in message, false);
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
  assert.ok(message.text.startsWith('<b><a href='));
  assert.doesNotMatch(message.text, /^#/);
  assert.doesNotMatch(message.text, /一句话 &lt;结论&gt;/);
  assert.match(message.text, /⏱️ 阅读时间：约 3 分钟\n<a href="[^"]+">💬 HN 讨论 · 10 条<\/a>$/);
  assert.equal(message.text.trimEnd(), message.text);
});

test('omits reading metadata when the article could not be extracted', () => {
  const unavailable: Draft = {
    ...draft,
    article: { text: '', source: 'unavailable', readingMinutes: null },
    summary: { ...summary, article: [], rewrite: { sections: [] } },
  };

  const message = renderTelegramMessage(unavailable, 'https://telegra.ph/unavailable');
  assert.match(message.text, /（★ 200 分）/);
  assert.match(message.text, />💬 HN 讨论 · 10 条<\/a>\n\n#AI #编程语言$/);
  assert.doesNotMatch(message.text, /阅读时间|分钟|估算|中文全文|中文阅读|telegra\.ph/);
  assert.equal(message.link_preview_options.is_disabled, false);
  assert.equal(message.link_preview_options.url, 'https://telegra.ph/unavailable');
  assert.equal('reply_markup' in message, false);
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
  const message = renderTelegramMessage(legacyDraft, 'https://telegra.ph/legacy');
  assert.equal(message.link_preview_options.url, 'https://telegra.ph/legacy');
  assert.equal('reply_markup' in message, false);
});

test('previous scan cards with suitability fields remain readable without rendering those fields', () => {
  const persisted = publicationSchema.parse({
    ...readyPublication(draft, 1),
    draft: {
      ...draft,
      summary: {
        ...draft.summary,
        tags: ['其他', '网络', 'AI', '编程语言'],
        format: undefined,
        introduction: '旧导语',
        whyItMatters: ['原先的看点', '另一个看点'],
        discussion: [{ heading: '旧主题', text: '旧讨论内容', commentIds: [124] }],
        readIf: '关注 AI 编程',
        skipIf: '只需要成熟工具',
      },
    },
  });

  const message = renderTelegramMessage(persisted.draft, 'https://telegra.ph/previous-card');
  assert.match(message.text, /#AI #编程语言/);
  assert.doesNotMatch(message.text, /#其他|#网络|关注 AI 编程|只需要成熟工具|适合你|可以跳过/);
});

test('narrative paragraphs use shared citation numbers and no misleading coverage fraction', () => {
  const narrative: Draft = {
    ...draft,
    commentCount: 0,
    summary: {
      ...draft.summary,
      format: 'narrative-v1',
      title: '新摘要',
      tags: [],
      quickTake: '唯一导语',
      article: [{ heading: null, paragraphs: ['第一段原文', '第二段原文'] }],
      discussion: [
        { text: '经验与反例。', commentIds: [124, 125, 124] },
        { text: '后续回应。', commentIds: [125, 126] },
      ],
    },
  };
  const nodes = renderTelegraphPage(narrative);
  const paragraphs = nodes.filter((node) => typeof node !== 'string' && node.tag === 'p');
  const discussion = paragraphs.filter(
    (node) =>
      typeof node !== 'string' &&
      ['经验与反例。', '后续回应。'].includes(String(node.children?.[0])),
  );
  assert.deepEqual(
    discussion.map((node) =>
      typeof node === 'string'
        ? []
        : node.children
            ?.filter((child) => typeof child !== 'string')
            .map((child) => (typeof child === 'string' ? null : child.children)),
    ),
    [
      [['[1]'], ['[2]']],
      [['[2]'], ['[3]']],
    ],
  );
  const content = JSON.stringify(nodes);
  assert.doesNotMatch(content, /"h4"|相关评论|1\/0|15 秒版|看点/);
  assert.match(content, /本次读取 1 条评论/);
  assert.equal(content.match(/唯一导语/g)?.length, 1);
  assert.match(content, /第一段原文/);
  assert.match(content, /第二段原文/);
  assert.equal(
    publicationSchema.parse(readyPublication(narrative, 1)).draft.summary.article[0]?.heading,
    null,
  );
});

test('combines article and cited HN discussion in one expandable Telegram block', () => {
  const combined: Draft = {
    ...draft,
    summary: {
      ...summary,
      article: [{ heading: null, paragraphs: ['原文短摘要 & <重点>'] }],
      discussion: [
        { text: '社区补充 <例子>', commentIds: [124, 125, 124] },
        { text: '另一条回应', commentIds: [125] },
      ],
    },
  };
  const message = renderTelegramMessage(combined, 'https://telegra.ph/rewrite');
  const document = new JSDOM(message.text).window.document;
  const blocks = document.querySelectorAll('blockquote');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.hasAttribute('expandable'), true);
  assert.match(
    blocks[0]?.textContent ?? '',
    /^原文短摘要 & <重点>[\s\S]*HN 补充[\s\S]*社区补充 <例子>/,
  );
  assert.deepEqual(
    [...(blocks[0]?.querySelectorAll('a') ?? [])].map((node) => [node.textContent, node.href]),
    [
      ['[1]', 'https://news.ycombinator.com/item?id=124'],
      ['[2]', 'https://news.ycombinator.com/item?id=125'],
      ['[2]', 'https://news.ycombinator.com/item?id=125'],
    ],
  );
  assert.equal(document.querySelector('a')?.href, draft.story.url);
  assert.equal(document.querySelector('a')?.textContent, combined.summary.title);
  assert.equal(document.querySelector('a[href="https://telegra.ph/rewrite"]'), null);
  assert.equal(document.querySelectorAll('blockquote blockquote, script').length, 0);
  assert.doesNotMatch(document.body.textContent ?? '', /一句话 <结论>|原文摘要/);
  assert.equal(
    document.querySelectorAll('a[href="https://news.ycombinator.com/item?id=123"]').length,
    1,
  );
  assert.equal(
    document.querySelector('a[href="https://news.ycombinator.com/item?id=123"]')?.textContent,
    '💬 HN 讨论 · 10 条',
  );
  assert.equal(document.querySelector('b > a')?.textContent, combined.summary.title);
  assert.match(message.text, /<\/b> （★ 200 分）\n\n<blockquote expandable>/);
  assert.equal(message.link_preview_options.url, 'https://telegra.ph/rewrite');
  assert.equal(message.link_preview_options.show_above_text, false);
  assert.equal('reply_markup' in message, false);
});

test('renders a bold source headline with inline score and keeps tags on the final line', () => {
  const rewritten: Draft = {
    ...draft,
    story: { ...draft.story, score: 450 },
    summary: {
      ...summary,
      rewrite: { sections: [{ heading: null, paragraphs: ['完整改写。'], imageIds: [] }] },
    },
  };
  const message = renderTelegramMessage(rewritten, 'https://telegra.ph/full');
  assert.equal(
    message.text.split('\n')[0],
    '<b><a href="https://example.com/article">中文 &amp; &lt;标题&gt;</a></b> （★ 450 分 🔥）',
  );
  assert.match(message.text, /<\/b> （★ 450 分 🔥）\n\n<blockquote expandable>/);
  assert.equal(
    message.text.split('</blockquote>')[1],
    '\n\n🔗 原文：<a href="https://example.com/article">https://example.com/article</a>\n⏱️ 阅读时间：约 3 分钟\n<a href="https://news.ycombinator.com/item?id=123">💬 HN 讨论 · 10 条</a>\n\n#AI #编程语言',
  );
  assert.doesNotMatch(message.text, /telegra\.ph|中文全文|中文阅读/);
  assert.deepEqual(message.link_preview_options, {
    is_disabled: false,
    url: 'https://telegra.ph/full',
    prefer_large_media: true,
    show_above_text: false,
  });
  assert.equal('reply_markup' in message, false);
});

test('escapes the source link as HTML while keeping the native preview URL unchanged', () => {
  const sourceUrl = 'https://example.com/article?one=1&two=2';
  const pageUrl = 'https://telegra.ph/read?lang=zh&ref=channel';
  const message = renderTelegramMessage(
    { ...draft, story: { ...draft.story, url: sourceUrl } },
    pageUrl,
  );
  assert.match(message.text, /href="https:\/\/example.com\/article\?one=1&amp;two=2"/);
  assert.equal(new JSDOM(message.text).window.document.querySelector('a')?.href, sourceUrl);
  assert.equal(message.link_preview_options.url, pageUrl);
  assert.equal('reply_markup' in message, false);
  assert.doesNotMatch(message.text, /telegra\.ph/);
});

test('cover images stay on the reading page while channel delivery keeps a native preview', () => {
  const pictured: Draft = {
    ...draft,
    article: {
      ...draft.article,
      media: { coverImage: 'https://example.com/cover.jpg', images: [] },
    },
  };
  const message = renderTelegramMessage(pictured, 'https://telegra.ph/read');
  assert.deepEqual(renderTelegramDelivery(pictured, 'https://telegra.ph/read'), {
    kind: 'text',
    payload: message,
  });
  assert.deepEqual(renderTelegramDelivery(draft, 'https://telegra.ph/read'), {
    kind: 'text',
    payload: renderTelegramMessage(draft, 'https://telegra.ph/read'),
  });
});

test('cover images do not restrict channel text to the 1024-character photo caption limit', () => {
  const pictured: Draft = {
    ...draft,
    article: {
      ...draft.article,
      media: { coverImage: 'https://example.com/cover.jpg', images: [] },
    },
    summary: {
      ...summary,
      article: [{ heading: null, paragraphs: ['甲'.repeat(1100)] }],
      discussion: [],
    },
  };
  const planned = renderTelegramDelivery(pictured, 'https://telegra.ph/read');
  assert.equal(planned.kind, 'text');
  assert.ok(parsedTextLength(planned.payload.text) > 1024);
  assert.ok(parsedTextLength(planned.payload.text) <= 4096);
  assert.equal(planned.payload.link_preview_options.url, 'https://telegra.ph/read');
});

test('delivery hashes track the native reading page rather than a separate photo attachment', () => {
  const first: Draft = {
    ...draft,
    article: {
      ...draft.article,
      media: { coverImage: 'https://example.com/first.jpg', images: [] },
    },
  };
  const second: Draft = {
    ...first,
    article: {
      ...first.article,
      media: { coverImage: 'https://example.com/second.jpg', images: [] },
    },
  };
  assert.deepEqual(
    renderTelegramMessage(first, 'https://telegra.ph/read'),
    renderTelegramMessage(second, 'https://telegra.ph/read'),
  );
  assert.equal(
    telegramMessageHash(first, 'https://telegra.ph/read'),
    telegramMessageHash(second, 'https://telegra.ph/read'),
  );
  assert.equal(
    telegramMessageHash(first, 'https://telegra.ph/read'),
    telegramMessageHash(draft, 'https://telegra.ph/read'),
  );
  assert.notEqual(
    telegramMessageHash(first, 'https://telegra.ph/read'),
    telegramMessageHash(first, 'https://telegra.ph/revised'),
  );
});

test('bounds long escaped messages without cutting HTML or citation links', () => {
  const oversized: Draft = {
    ...draft,
    summary: {
      ...summary,
      article: Array.from({ length: 12 }, (_, index) => ({
        heading: `第 ${index + 1} 节`,
        paragraphs: ['<&😀>'.repeat(500), '尾段'.repeat(500)],
      })),
      discussion: Array.from({ length: 12 }, () => ({
        text: '<讨论 & 细节>'.repeat(200),
        commentIds: [124, 125],
      })),
    },
  };
  const message = renderTelegramMessage(oversized, 'https://telegra.ph/complete');
  const document = new JSDOM(message.text).window.document;
  assert.ok((document.body.textContent?.length ?? 0) <= 4096);
  assert.ok(
    message.text.length > 4096,
    'escaped HTML does not consume the visible-character budget',
  );
  assert.equal(document.querySelectorAll('blockquote').length, 1);
  assert.equal(document.querySelectorAll('script').length, 0);
  assert.match(document.querySelector('blockquote')?.textContent ?? '', /…/);
  assert.equal(document.querySelector('a')?.href, draft.story.url);
  assert.equal(
    document.querySelector('blockquote a')?.getAttribute('href'),
    'https://news.ycombinator.com/item?id=124',
  );
  assert.doesNotMatch(message.text, /\uD800(?![\uDC00-\uDFFF])|[\uD800-\uDBFF]$/u);
  assert.equal(message.link_preview_options.url, 'https://telegra.ph/complete');
  assert.equal('reply_markup' in message, false);
});

test('renders the rewrite with source media and keeps HN discussion in the Telegram message', () => {
  const rewritten: Draft = {
    ...draft,
    article: {
      ...draft.article,
      media: {
        coverImage: 'https://example.com/cover.png',
        images: [
          { id: 'cover', url: 'https://example.com/cover.png', caption: '封面图' },
          { id: 'chart', url: 'https://example.com/chart.png', caption: '结果 & <图注>' },
        ],
      },
    },
    summary: {
      ...summary,
      rewrite: {
        sections: [
          {
            heading: '重写正文',
            paragraphs: ['完整的论证与关键数据。'],
            imageIds: ['cover', 'chart', 'missing'],
          },
          { heading: null, paragraphs: ['后续内容。'], imageIds: ['chart'] },
        ],
      },
    },
  };
  const nodes = renderTelegraphPage(rewritten);
  const content = JSON.stringify(nodes);
  assert.match(content, /完整的论证与关键数据。/);
  assert.match(content, /封面图/);
  assert.match(content, /结果 & <图注>/);
  assert.match(content, /AI 生成/);
  assert.match(content, /阅读原文/);
  assert.match(content, /item\?id=123/);
  assert.doesNotMatch(content, /HN 讨论综述|用户补充|主要内容|原文摘要/);
  assert.equal(content.match(/https:\/\/example.com\/cover.png/g)?.length, 1);
  assert.equal(content.match(/https:\/\/example.com\/chart.png/g)?.length, 1);
  assert.equal(nodes.filter((node) => typeof node !== 'string' && node.tag === 'figure').length, 2);
  assert.match(renderTelegramMessage(rewritten, 'https://telegra.ph/rewrite').text, /用户补充/);
  const message = new JSDOM(renderTelegramMessage(rewritten, 'https://telegra.ph/rewrite').text)
    .window.document;
  assert.equal(message.querySelector('a')?.href, draft.story.url);
  assert.equal(message.querySelector('a[href="https://telegra.ph/rewrite"]'), null);
});

test('rewrite previews start with the full article and move original attribution to the footer', () => {
  const rewritten: Draft = {
    ...draft,
    article: {
      ...draft.article,
      media: { coverImage: 'https://example.com/cover.png', images: [] },
    },
    summary: {
      ...summary,
      rewrite: {
        sections: [
          { heading: null, paragraphs: ['完整改写的独立开头。', '后续论证。'], imageIds: [] },
        ],
      },
    },
  };
  const nodes = renderTelegraphPage(rewritten);
  const content = JSON.stringify(nodes);
  assert.deepEqual(nodes[0], {
    tag: 'figure',
    children: [{ tag: 'img', attrs: { src: 'https://example.com/cover.png' } }],
  });
  assert.deepEqual(
    nodes.find((node) => typeof node !== 'string' && node.tag === 'p'),
    { tag: 'p', children: ['完整改写的独立开头。'] },
  );
  assert.doesNotMatch(content, /一句话 <结论>/);
  assert.doesNotMatch(content, /原标题：/);
  assert.deepEqual(nodes.at(-3), {
    tag: 'p',
    children: [
      { tag: 'a', attrs: { href: 'https://example.com/article' }, children: ['阅读原文'] },
      ' · ',
      {
        tag: 'a',
        attrs: { href: 'https://news.ycombinator.com/item?id=123' },
        children: ['HN 讨论'],
      },
    ],
  });
  assert.equal(content.match(/https:\/\/example.com\/article/g)?.length, 1);
  assert.deepEqual(nodes.at(-2), { tag: 'p', children: ['生成于 2026/09/18 08:00（北京时间）'] });
  assert.deepEqual(nodes.at(-1), {
    tag: 'p',
    children: [{ tag: 'em', children: ['本文为 AI 生成的中文改写，请以原文为准。'] }],
  });
});

test('all reading pages put source links before metadata and leave the disclaimer last', () => {
  const rewritten: Draft = {
    ...draft,
    summary: {
      ...summary,
      rewrite: { sections: [{ heading: null, paragraphs: ['正文。'], imageIds: [] }] },
    },
  };
  const unavailable: Draft = {
    ...rewritten,
    article: { source: 'unavailable', text: '', readingMinutes: null },
    summary: { ...summary, article: [], rewrite: { sections: [] } },
  };
  for (const sample of [draft, rewritten, unavailable]) {
    const nodes = renderTelegraphPage(sample);
    assert.deepEqual(nodes.at(-4), { tag: 'hr' });
    assert.match(JSON.stringify(nodes.at(-3)), /阅读原文.*HN 讨论/);
    assert.match(JSON.stringify(nodes.at(-2)), /生成于 2026\/09\/18 08:00（北京时间）/);
    assert.match(JSON.stringify(nodes.at(-1)), /"tag":"em".*AI 生成/);
  }
});

test('unavailable rewrite pages direct readers to the message and HN discussion link', () => {
  const unavailable: Draft = {
    ...draft,
    article: { text: '', source: 'unavailable', readingMinutes: null },
    summary: { ...summary, article: [], rewrite: { sections: [] } },
  };
  const content = JSON.stringify(renderTelegraphPage(unavailable));
  assert.match(content, /原文正文暂时无法获取/);
  assert.match(content, /HN 讨论请见频道消息或文末讨论链接/);
  assert.doesNotMatch(content, /以下讨论摘要|HN 讨论综述|用户补充/);
  assert.match(content, /item\?id=123/);
});

test('does not render unsupported media URLs and keeps the Telegraph byte limit', () => {
  const invalidMedia: Draft = {
    ...draft,
    article: {
      ...draft.article,
      media: {
        coverImage: 'javascript:alert(1)',
        images: [{ id: 'bad', url: 'data:image/png;base64,x', caption: 'bad' }],
      },
    },
    summary: {
      ...summary,
      rewrite: { sections: [{ heading: null, paragraphs: ['正文'], imageIds: ['bad'] }] },
    },
  };
  assert.doesNotMatch(
    JSON.stringify(renderTelegraphPage(invalidMedia)),
    /javascript:|data:image|"figure"/,
  );
  const enormous: Draft = {
    ...draft,
    summary: {
      ...summary,
      rewrite: { sections: [{ heading: null, paragraphs: ['正文'.repeat(15000)], imageIds: [] }] },
    },
  };
  assert.throws(() => renderTelegraphPage(enormous), /exceeds 64 KB/);
});

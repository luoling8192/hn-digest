import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Response } from 'undici';
import {
  ArticleExtractor,
  estimateReadingMinutes,
  isPublicAddress,
  parsePublicHttpUrl,
} from '../src/adapters/article-extractor.js';
import {
  articleSchema,
  persistedSummarySchema,
  publicationSchema,
  readyPublication,
} from '../src/domain.js';
import { silentLogger } from '../src/logger.js';
import { draft } from './fixtures.js';

const articleText = 'The article explains its findings and supporting evidence. '.repeat(20);
const mediaStory = {
  id: 1,
  type: 'story',
  time: 1,
  kids: [],
  url: 'https://example.com/posts/story',
};

async function extractMedia(html: string, metadata: Record<string, unknown> = {}) {
  const extractor = new ArticleExtractor(silentLogger, 'test-firecrawl-key', async () =>
    Response.json({
      success: true,
      data: { markdown: articleText, html, metadata: { statusCode: 200, ...metadata } },
    }),
  );
  return extractor.extract(mediaStory);
}

test('article URL validation blocks local, metadata, private, and mapped private addresses', () => {
  for (const address of [
    '127.0.0.1',
    '169.254.169.254',
    '10.1.2.3',
    '192.168.1.1',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
  ]) {
    assert.equal(isPublicAddress(address), false);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.throws(() => parsePublicHttpUrl('http://127.0.0.1/admin'));
  assert.throws(() => parsePublicHttpUrl('file:///etc/passwd'));
});

test('reading estimates combine Latin words and Han characters', () => {
  assert.equal(estimateReadingMinutes('word '.repeat(220)), 1);
  assert.equal(estimateReadingMinutes('字'.repeat(401)), 2);
});

test('HN text posts are read locally without using paid extraction', async () => {
  const extractor = new ArticleExtractor(silentLogger, 'test-firecrawl-key', async () => {
    assert.fail('HN text posts must not request the extraction service');
  });
  const article = await extractor.extract({
    id: 1,
    type: 'story',
    time: 1,
    kids: [],
    text: '<p>Hello &amp; world.</p>',
  });
  assert.deepEqual(article, { text: 'Hello & world.', source: 'hn-text', readingMinutes: 1 });
  assert.equal(
    (await extractor.extract({ id: 2, type: 'story', time: 1, kids: [] })).source,
    'unavailable',
  );
});

test('unsafe article URLs are rejected before any paid request', async () => {
  const extractor = new ArticleExtractor(silentLogger, 'test-firecrawl-key', async () => {
    assert.fail('Unsafe article URLs must not reach the extraction service');
  });
  for (const url of [
    'http://127.0.0.1/admin',
    'file:///etc/passwd',
    'https://user:password@example.com',
  ]) {
    const article = await extractor.extract({ id: 1, type: 'story', time: 1, kids: [], url });
    assert.equal(article.source, 'unavailable');
    assert.equal(article.failureCode, 'unsafe_article_url');
  }
});

test('Firecrawl OG images survive extraction and persisted article schemas without body images', async () => {
  const article = await extractMedia('<article><p>Article content</p></article>', {
    ogImage: '/preview.jpg',
  });
  const media = { coverImage: 'https://example.com/preview.jpg', images: [] };
  assert.deepEqual(articleSchema.parse(article).media, media);
  assert.deepEqual(
    publicationSchema.parse(readyPublication({ ...draft, article }, 1)).draft.article.media,
    media,
  );
  assert.equal(article.text, articleText);
});

test('article images keep source order, relative URLs and figure captions with stable IDs', async () => {
  const html = `<article>
    <figure><img src="../images/chart.png" width="800" height="500" alt="alt text"><figcaption>Figure 1: <em>Measured results</em></figcaption></figure>
    <img src="//cdn.example.com/screenshot.jpg" alt="The settings screen">
    <img src="../images/chart.png" alt="Duplicate">
  </article>`;
  const article = await extractMedia(html);
  const again = await extractMedia(html);
  assert.equal(article.media?.coverImage, 'https://example.com/images/chart.png');
  assert.deepEqual(
    article.media?.images.map(({ url, caption }) => ({ url, caption })),
    [
      { url: 'https://example.com/images/chart.png', caption: 'Figure 1: Measured results' },
      { url: 'https://cdn.example.com/screenshot.jpg', caption: 'The settings screen' },
    ],
  );
  assert.match(article.media?.images[0]?.id ?? '', /^image-[a-f0-9]{12}$/);
  assert.deepEqual(again.media, article.media);
});

test('lazy images use their public data source when src is an inline placeholder', async () => {
  const article = await extractMedia(`<article>
    <figure><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" data-src="../images/lazy.jpg" width="800" height="600" alt="Lazy source figure"></figure>
    <img src="/images/loaded.jpg" data-src="/images/unused.jpg" alt="Already loaded figure">
  </article>`);
  assert.equal(article.media?.coverImage, 'https://example.com/images/lazy.jpg');
  assert.deepEqual(
    article.media?.images.map(({ url, caption }) => ({ url, caption })),
    [
      { url: 'https://example.com/images/lazy.jpg', caption: 'Lazy source figure' },
      { url: 'https://example.com/images/loaded.jpg', caption: 'Already loaded figure' },
    ],
  );
});

test('media extraction excludes unsafe URLs and obvious tiny, tracking and navigation images', async () => {
  const article = await extractMedia(
    `<article>
    <img src="javascript:alert(1)"><img src="data:image/png;base64,AAAA">
    <img src="http://127.0.0.1/image.jpg"><img src="http://10.0.0.1/image.jpg">
    <img src="http://[::1]/image.jpg"><img src="https://user:password@example.com/image.jpg">
    <img src="https://example.com/pixel.gif" width="1" height="1">
    <img src="/hidden.jpg" width="0" height="0">
    <img src="https://example.com/favicon.png"><img src="/img/chart.png" width="32" height="24">
    <nav><img src="/navigation.jpg"></nav><img src="/tracking/beacon.gif">
    <figure><img src="/diagram.svg" width="900" height="600"><figcaption>Architecture</figcaption></figure>
  </article>`,
    { ogImage: 'http://169.254.169.254/cover.jpg' },
  );
  assert.deepEqual(
    article.media?.images.map(({ url }) => url),
    ['https://example.com/diagram.svg'],
  );
  assert.equal(article.media?.coverImage, 'https://example.com/diagram.svg');
});

test('media extraction bounds content images while preserving the preferred OG cover', async () => {
  const article = await extractMedia(
    Array.from({ length: 12 }, (_, index) => `<img src="/figure-${index}.jpg">`).join(''),
    { ogImage: 'https://cdn.example.com/cover.jpg' },
  );
  assert.equal(article.media?.images.length, 8);
  assert.equal(article.media?.images[7]?.url, 'https://example.com/figure-7.jpg');
  assert.equal(article.media?.coverImage, 'https://cdn.example.com/cover.jpg');
});

test('rewrite sections and their source image references survive persisted summaries', () => {
  const rewrite = {
    sections: [{ heading: null, paragraphs: ['The rewritten article.'], imageIds: ['image-123'] }],
  };
  const summary = { ...draft.summary, rewrite };
  assert.deepEqual(persistedSummarySchema.parse(summary), summary);
  assert.equal(
    persistedSummarySchema.safeParse({
      ...summary,
      rewrite: { sections: [{ heading: null, paragraphs: [], imageIds: [] }] },
    }).success,
    false,
  );
});

test('an unavailable article permits an empty rewrite without fabricating source content', () => {
  const publication = publicationSchema.parse(
    readyPublication(
      {
        ...draft,
        article: { text: '', source: 'unavailable', readingMinutes: null },
        summary: { ...draft.summary, rewrite: { sections: [] } },
      },
      1,
    ),
  );
  assert.deepEqual(
    'format' in publication.draft.summary ? publication.draft.summary.rewrite : undefined,
    { sections: [] },
  );
});

test('legacy stored articles and summaries remain readable without media or rewrite', () => {
  assert.deepEqual(articleSchema.parse(draft.article), draft.article);
  assert.deepEqual(persistedSummarySchema.parse(draft.summary), draft.summary);
  const legacySummary = {
    title: 'Legacy title',
    introduction: 'Introduction',
    article: [{ heading: 'Article', paragraphs: ['Content'] }],
    discussion: [],
  };
  assert.deepEqual(persistedSummarySchema.parse(legacySummary), legacySummary);
});

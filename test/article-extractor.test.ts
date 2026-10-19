import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ArticleExtractor,
  estimateReadingMinutes,
  isPublicAddress,
  parsePublicHttpUrl,
} from '../src/adapters/article-extractor.js';
import { silentLogger } from '../src/logger.js';

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

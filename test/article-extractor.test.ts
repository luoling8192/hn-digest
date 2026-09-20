import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Response } from 'undici';
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

test('article extraction uses rendered reader content when static HTML is only a JavaScript shell', async () => {
  const requests: string[] = [];
  const responses = [
    new Response('<html><body><div id="root"></div><script src="/app.js"></script></body></html>', {
      headers: { 'content-type': 'text/html' },
    }),
    new Response(
      `Title: Dynamic article

URL Source: https://example.com/dynamic

Markdown Content:
## Loaded in the browser

${'Rendered article content. '.repeat(20)}`,
      { headers: { 'content-type': 'text/plain' } },
    ),
  ];
  const extractor = new ArticleExtractor(silentLogger, async (input) => {
    requests.push(input.toString());
    const response = responses.shift();
    assert.ok(response);
    return response;
  });

  const article = await extractor.extract({
    id: 49771110,
    type: 'story',
    time: 1,
    url: 'https://example.com/dynamic#section',
    kids: [],
  });

  assert.deepEqual(requests, [
    'https://example.com/dynamic#section',
    'https://r.jina.ai/https://example.com/dynamic',
  ]);
  assert.equal(article.source, 'article');
  assert.match(article.text, /^## Loaded in the browser/);
  assert.doesNotMatch(article.text, /URL Source:/);
  assert.ok(article.readingMinutes);
});

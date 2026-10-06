import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Headers, Response } from 'undici';
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

test('article extraction uses Jina first without requesting the origin', async () => {
  const requests: string[] = [];
  const responses = [
    new Response(
      JSON.stringify({
        data: {
          title: 'Dynamic article',
          content: `## Loaded in the browser\n${'Rendered article content. '.repeat(20)}`,
        },
      }),
      { headers: { 'content-type': 'application/json' } },
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

  assert.deepEqual(requests, ['https://r.jina.ai/https://example.com/dynamic']);
  assert.equal(article.source, 'article');
  assert.match(article.text, /^## Loaded in the browser/);
  assert.doesNotMatch(article.text, /URL Source:/);
  assert.ok(article.readingMinutes);
});

test('Jina failures fall back to direct fetch and never forward the API key to the origin', async () => {
  const attempts: string[] = [];
  const extractor = new ArticleExtractor(
    silentLogger,
    async (input, init) => {
      attempts.push(String(input));
      const headers = new Headers(init?.headers);
      if (attempts.length === 1) {
        assert.equal(headers.get('authorization'), 'Bearer test-jina-key');
        return new Response('Unavailable', { status: 429 });
      }
      assert.equal(headers.get('authorization'), null);
      return new Response('Original article. '.repeat(30), {
        headers: { 'content-type': 'text/plain' },
      });
    },
    'test-jina-key',
  );
  const article = await extractor.extract({
    id: 123,
    type: 'story',
    time: 1,
    kids: [],
    url: 'https://example.com/article',
  });
  assert.equal(article.source, 'article');
  assert.equal(attempts.length, 2);
});

test('failed attempts log each method and concrete reason without secrets or content', async () => {
  const events: unknown[] = [];
  const extractor = new ArticleExtractor(
    { ...silentLogger, warn: (event, fields) => events.push({ event, ...fields }) },
    async (input) => {
      if (String(input).startsWith('https://r.jina.ai/')) {
        return new Response(
          JSON.stringify({
            data: { title: 'Just a moment...', content: 'Challenge content. '.repeat(30) },
          }),
        );
      }
      return new Response('Denied', { status: 403 });
    },
    'test-jina-key',
  );
  const article = await extractor.extract({
    id: 123,
    type: 'story',
    time: 1,
    kids: [],
    url: 'https://example.com/article',
  });
  assert.equal(article.source, 'unavailable');
  const logs = JSON.stringify(events);
  assert.match(logs, /article_challenge_page/);
  assert.match(logs, /article_http_403/);
  assert.match(logs, /all_fetch_methods_failed/);
  assert.doesNotMatch(logs, /test-jina-key|Challenge content/);
});

test('Jina can extract PDF articles that direct HTML extraction cannot handle', async () => {
  const extractor = new ArticleExtractor(
    silentLogger,
    async () =>
      new Response(
        JSON.stringify({ data: { title: 'book.pdf', content: 'PDF text. '.repeat(40) } }),
      ),
  );
  const article = await extractor.extract({
    id: 123,
    type: 'story',
    time: 1,
    kids: [],
    url: 'https://example.com/book.pdf',
  });
  assert.equal(article.source, 'article');
});

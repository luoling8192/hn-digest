import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Headers, Response } from 'undici';
import { ArticleExtractor } from '../src/adapters/article-extractor.js';
import { silentLogger } from '../src/logger.js';

const endpoint = 'https://api.firecrawl.dev/v2/scrape';
const key = 'test-firecrawl-key';
const story = {
  id: 50136881,
  type: 'story',
  time: 1,
  kids: [],
  url: 'https://example.com/story#section',
};
const content = 'Reporting from the original article, retrieved through Firecrawl. '.repeat(20);

function page(markdown = content, statusCode = 200, title = 'Original reporting') {
  return Response.json({ success: true, data: { markdown, metadata: { title, statusCode } } });
}

test('Firecrawl is the only remote extraction service and receives its own API key', async () => {
  const requests: string[] = [];
  const extractor = new ArticleExtractor(silentLogger, key, async (input, init) => {
    requests.push(String(input));
    assert.equal(String(input), endpoint);
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${key}`);
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      url: 'https://example.com/story',
      formats: ['markdown', 'html'],
      onlyMainContent: true,
      proxy: 'auto',
      waitFor: 1500,
      maxAge: 0,
      timeout: 60000,
    });
    return page();
  });
  const article = await extractor.extract(story);
  assert.equal(article.source, 'article');
  assert.equal(article.text, content);
  assert.deepEqual(requests, [endpoint]);
});

test('a failed Firecrawl request remains a failure without trying another service or origin', async () => {
  const events: unknown[] = [];
  const requests: string[] = [];
  const extractor = new ArticleExtractor(
    { ...silentLogger, warn: (event, fields) => events.push({ event, ...fields }) },
    key,
    async (input) => {
      requests.push(String(input));
      return new Response('Blocked', { status: 403 });
    },
  );
  const article = await extractor.extract(story);
  assert.equal(article.source, 'unavailable');
  assert.equal(article.failureCode, 'firecrawl_http_403');
  assert.deepEqual(requests, [endpoint]);
  const logs = JSON.stringify(events);
  assert.match(logs, /article_fetch_failed/);
  assert.match(logs, /firecrawl_http_403/);
  assert.doesNotMatch(logs, /test-firecrawl-key|Blocked|https:\/\/example/);
});

for (const status of [401, 402]) {
  test(`Firecrawl HTTP ${status} exposes credentials or quota failure without a fallback`, async () => {
    let calls = 0;
    const extractor = new ArticleExtractor(silentLogger, key, async () => {
      calls++;
      return new Response('', { status });
    });
    assert.equal((await extractor.extract(story)).failureCode, `firecrawl_http_${status}`);
    assert.equal(calls, 1);
  });
}

test('Firecrawl HTTP 200 cannot turn an origin error page into a successful article', async () => {
  const extractor = new ArticleExtractor(silentLogger, key, async () => page(content, 404));
  const article = await extractor.extract(story);
  assert.equal(article.source, 'unavailable');
  assert.equal(article.failureCode, 'article_http_404');
});

test('a provider-reported failure is rejected even when the API returns HTTP 200', async () => {
  const extractor = new ArticleExtractor(silentLogger, key, async () =>
    Response.json({ success: false }),
  );
  assert.equal((await extractor.extract(story)).failureCode, 'invalid_remote_data');
});

test('a challenge page cannot become source text through a successful scrape', async () => {
  const extractor = new ArticleExtractor(silentLogger, key, async () =>
    page(content, 200, 'Attention Required! | Cloudflare'),
  );
  assert.equal((await extractor.extract(story)).failureCode, 'article_challenge_page');
});

test('an application title without enough readable text is not an article', async () => {
  const extractor = new ArticleExtractor(silentLogger, key, async () =>
    page('An interactive game'),
  );
  assert.equal((await extractor.extract(story)).failureCode, 'article_text_insufficient');
});

for (const layout of ['medium', 'ordinary', 'different-post'] as const) {
  test(`Medium response contamination: ${layout} layout retains only verified source content`, async () => {
    const postId = '123456abcdef';
    const byline =
      layout === 'ordinary'
        ? ''
        : `[Author](https://medium.com/@writer?source=post_page---byline--${postId}---)\n\n`;
    const original = `${byline}# Report\n\n${content}\n\nUpdate 3: The publisher verified additional evidence.`;
    const responseId = layout === 'different-post' ? 'abcdef123456' : postId;
    const markdown = `${original}\n\n## Responses (6)\n\n[What are your thoughts?](https://medium.com/m/signin?source=---post_responses--${responseId}---)\n\nREADER_SPECULATION_MUST_NOT_BE_ARTICLE\n\n## More from this author\n\nRECOMMENDED_OTHER_ARTICLE`;
    const extractor = new ArticleExtractor(silentLogger, key, async () => page(markdown));
    const article = await extractor.extract(story);
    assert.equal(article.source, 'article');
    assert.match(article.text, /Update 3: The publisher verified additional evidence/);
    assert.equal(article.text, layout === 'medium' ? original : markdown);
  });
}

for (const layout of ['reuters', 'other-host', 'ordinary-heading'] as const) {
  test(`Reuters recommendation contamination: ${layout} preserves the reported article boundary`, async () => {
    const original = `${content}\n\nReporting by the newsroom; Editing by the editor`;
    const footer =
      layout === 'ordinary-heading'
        ? ''
        : '\n\nOur Standards: [The Thomson Reuters Trust Principles](https://www.thomsonreuters.com/en/about-us/trust-principles.html)';
    const markdown = `${original}${footer}\n\n## Read Next\n\nUNRELATED_REPORT_MUST_NOT_BE_SOURCE`;
    const extractor = new ArticleExtractor(silentLogger, key, async () => page(markdown));
    const article = await extractor.extract({
      ...story,
      url: layout === 'other-host' ? story.url : 'https://www.reuters.com/world/report',
    });
    assert.equal(article.source, 'article');
    assert.equal(article.text, layout === 'reuters' ? original : markdown);
  });
}

for (const gated of [true, false]) {
  test(`Firecrawl ${gated ? 'rejects a gated preview even with lengthy navigation' : 'accepts a readable article with an ordinary subscription footer'}`, async () => {
    const markdown = gated
      ? `${content}\n\n### To continue reading, choose an option below.\n\nUnlimited Access\n\n#### Subscribe to WSJ Today\n\n${'Related stories and market prices. '.repeat(100)}`
      : `${content}\n\nSubscribe to our newsletter for updates.\n\nThe article explains why publishers ask readers to sign in to continue.`;
    const extractor = new ArticleExtractor(silentLogger, key, async () => page(markdown));
    const article = await extractor.extract(story);
    assert.equal(article.source, gated ? 'unavailable' : 'article');
    if (gated) assert.equal(article.failureCode, 'article_challenge_page');
    else assert.equal(article.text, markdown);
  });
}

for (const gate of [
  'This article is for **subscribers only**.',
  '## Continue with a free trial\n\n### Get full access to our independent journalism for free\n\nOr create a free account to unlock just this article',
]) {
  test(`an explicit article access gate is rejected: ${gate.split('\n')[0]}`, async () => {
    const extractor = new ArticleExtractor(silentLogger, key, async () =>
      page(`${content}\n\n${gate}\n\n${'Other headlines and recommendations. '.repeat(100)}`),
    );
    const article = await extractor.extract(story);
    assert.equal(article.source, 'unavailable');
    assert.equal(article.failureCode, 'article_challenge_page');
  });
}

const captchaForm = `Become a Member in Seconds

Unlock instant access to exclusive member features.

An account already exists for this email address, please log in.

Chargebee

hCaptcha

hCaptcha

Please try again. ⚠️

Verify

Afrikaans

Albanian

Arabic

English

[hCaptcha logo, opens new window with more information](https://www.hcaptcha.com/what-is-hcaptcha-about?ref=js.chargebee.com&utm_medium=challenge&hl=en)`;

test('a membership and CAPTCHA form without an article heading is rejected', async () => {
  const extractor = new ArticleExtractor(silentLogger, key, async () => page(captchaForm));
  const article = await extractor.extract(story);
  assert.equal(article.source, 'unavailable');
  assert.equal(article.failureCode, 'article_challenge_page');
});

for (const markdown of [
  `${content}\n\nA publisher may write that this article is for subscribers only. The report discusses hCaptcha, Chargebee and account creation.`,
  `# Reporting on subscription services\n\n${content}\n\n${captchaForm}`,
  `${content}\n\n## Continue with a free trial\n\nThe article above is freely available; this offer is for our separate research service.`,
]) {
  test('subscription or CAPTCHA discussion and a form after a headed article remain usable', async () => {
    const extractor = new ArticleExtractor(silentLogger, key, async () => page(markdown));
    const article = await extractor.extract(story);
    assert.equal(article.source, 'article');
    assert.equal(article.text, markdown);
  });
}

test('rate limits pause all article requests until the shared Retry-After deadline', async () => {
  let calls = 0;
  let now = 0;
  const extractor = new ArticleExtractor(
    silentLogger,
    key,
    async () => {
      calls++;
      return calls === 1
        ? new Response('', { status: 429, headers: { 'retry-after': '120' } })
        : page();
    },
    { now: () => now },
  );
  assert.equal((await extractor.extract(story)).failureCode, 'firecrawl_http_429');
  now = 30_000;
  assert.equal((await extractor.extract({ ...story, id: 2 })).failureCode, 'firecrawl_http_429');
  assert.equal(calls, 1);
  now = 120_000;
  assert.equal((await extractor.extract({ ...story, id: 3 })).text, content);
  assert.equal(calls, 2);
});

test('concurrent rate limits cannot shorten an existing provider cooldown', async () => {
  let now = 0;
  let calls = 0;
  const respond: ((response: Response) => void)[] = [];
  let signalBoth!: () => void;
  const bothStarted = new Promise<void>((resolve) => {
    signalBoth = resolve;
  });
  const extractor = new ArticleExtractor(
    silentLogger,
    key,
    async () => {
      calls++;
      return new Promise<Response>((resolve) => {
        respond.push(resolve);
        if (respond.length === 2) signalBoth();
      });
    },
    { now: () => now },
  );
  const first = extractor.extract(story);
  const second = extractor.extract({ ...story, id: 2 });
  await bothStarted;
  respond[0]?.(new Response('', { status: 429, headers: { 'retry-after': '120' } }));
  await first;
  respond[1]?.(new Response('', { status: 429, headers: { 'retry-after': '1' } }));
  await second;
  now = 2000;
  assert.equal((await extractor.extract({ ...story, id: 3 })).failureCode, 'firecrawl_http_429');
  assert.equal(calls, 2);
});

test('Retry-After HTTP dates use the same clock as the shared cooldown', async () => {
  let now = Date.parse('2026-10-19T00:00:00Z');
  let calls = 0;
  const extractor = new ArticleExtractor(
    silentLogger,
    key,
    async () => {
      calls++;
      return calls === 1
        ? new Response('', {
            status: 429,
            headers: { 'retry-after': 'Mon, 19 Oct 2026 00:02:00 GMT' },
          })
        : page();
    },
    { now: () => now },
  );
  await extractor.extract(story);
  now += 30_000;
  assert.equal((await extractor.extract(story)).failureCode, 'firecrawl_http_429');
  assert.equal(calls, 1);
  now += 90_000;
  assert.equal((await extractor.extract(story)).source, 'article');
  assert.equal(calls, 2);
});

test('network failures preserve their concrete reason', async () => {
  const extractor = new ArticleExtractor(silentLogger, key, async () => {
    const cause = Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' });
    throw new TypeError('fetch failed', { cause });
  });
  assert.equal((await extractor.extract(story)).failureCode, 'ECONNRESET');
});

test('oversized provider responses cannot exhaust the source download budget', async () => {
  const extractor = new ArticleExtractor(silentLogger, key, async () =>
    page('x'.repeat(3_000_001)),
  );
  assert.equal((await extractor.extract(story)).failureCode, 'article_too_large');
});

test('long source text is capped for summarization and truncation is explicit in logs', async () => {
  const events: unknown[] = [];
  const text = content.repeat(40);
  const extractor = new ArticleExtractor(
    { ...silentLogger, info: (event, fields) => events.push({ event, ...fields }) },
    key,
    async () => page(text),
  );
  const article = await extractor.extract(story);
  assert.equal(article.text, text.slice(0, 45_000));
  assert.equal(article.source, 'article');
  const event = events.find(
    (event): event is { truncated: boolean; sourceCharacters: number } =>
      (event as { event: string }).event === 'article_fetch_succeeded',
  );
  assert.equal(event?.truncated, true);
  assert.equal(event?.sourceCharacters, text.length);
});

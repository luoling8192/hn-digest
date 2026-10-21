import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TelegraphClient } from '../src/adapters/telegraph.js';
import type { Draft, Page } from '../src/domain.js';
import { config, draft, summary } from './fixtures.js';

const page: Page = { path: 'existing-page-10-21', url: 'https://telegra.ph/existing-page-10-21' };
const rewritten: Draft = {
  ...draft,
  article: {
    ...draft.article,
    media: {
      coverImage: 'https://example.com/cover.jpg',
      images: [{ id: 'cover', url: 'https://example.com/cover.jpg', caption: '原文配图' }],
    },
  },
  summary: {
    ...summary,
    rewrite: {
      sections: [{ heading: '完整正文', paragraphs: ['独立改写的论证。'], imageIds: [] }],
    },
  },
};

test('created and edited rewrite pages keep the exact summary title without changing the draft', async () => {
  const requests: Array<{ url: string; service: string; body: Record<string, unknown> }> = [];
  const client = new TelegraphClient(config, {
    request: async (url, service, init) => {
      requests.push({ url, service, body: JSON.parse(String(init?.body)) });
      return { ok: true, result: page };
    },
  });
  const original = structuredClone(rewritten);

  assert.deepEqual(await client.save(rewritten, null), page);
  assert.deepEqual(await client.save(rewritten, page), page);
  assert.deepEqual(
    requests.map((request) => request.url),
    ['https://api.telegra.ph/createPage', 'https://api.telegra.ph/editPage'],
  );
  for (const request of requests) {
    assert.equal(request.service, 'telegraph');
    assert.equal(request.body.title, summary.title);
    assert.match(JSON.stringify(request.body.content), /独立改写的论证。/);
    assert.match(JSON.stringify(request.body.content), /https:\/\/example.com\/cover.jpg/);
    assert.match(JSON.stringify(request.body.content), /AI 生成/);
  }
  assert.equal(requests[0]?.body.path, undefined);
  assert.equal(requests[1]?.body.path, page.path);
  assert.deepEqual(rewritten, original);
});

test('legacy, empty rewrite, and unavailable pages retain their summary title', async () => {
  const inputs: Draft[] = [
    draft,
    { ...draft, summary: { ...summary, rewrite: { sections: [] } } },
    {
      ...draft,
      summary: {
        title: '旧摘要标题',
        introduction: '旧导语',
        article: [{ heading: '正文', paragraphs: ['旧摘要正文。'] }],
        discussion: [],
      },
    },
    { ...rewritten, article: { text: '', source: 'unavailable', readingMinutes: null } },
  ];
  const titles: unknown[] = [];
  const client = new TelegraphClient(config, {
    request: async (_url, _service, init) => {
      titles.push(JSON.parse(String(init?.body)).title);
      return { ok: true, result: page };
    },
  });

  for (const input of inputs) await client.save(input, null);
  assert.deepEqual(
    titles,
    inputs.map((input) => input.summary.title),
  );
});

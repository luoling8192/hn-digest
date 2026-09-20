import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenRouterSummarizer } from '../src/adapters/openrouter-summarizer.js';
import type { Summary } from '../src/domain.js';
import type { JsonHttpClient } from '../src/http-client.js';
import { silentLogger } from '../src/logger.js';
import { config, draft, story, summary } from './fixtures.js';

function completion(summary: Summary): unknown {
  return {
    choices: [
      {
        message: { content: JSON.stringify(summary) },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 200 },
  };
}

test('OpenRouter summaries retain supplied comment evidence in the resulting draft', async () => {
  let requestBody = '';
  const http: JsonHttpClient = {
    request: async (_url, _service, init) => {
      const body = init?.body;
      assert.equal(typeof body, 'string');
      if (typeof body !== 'string') throw new Error('Expected a JSON request body');
      requestBody = body;
      return completion(summary);
    },
  };
  const summarizer = new OpenRouterSummarizer(
    config,
    http,
    silentLogger,
    () => new Date('2026-09-18T08:00:00.000Z'),
  );

  const tagCatalog = [
    { tag: 'AI', uses: 8, examples: ['AI 编程助手'] },
    { tag: '开发工具', uses: 3, examples: ['本地编程环境'] },
  ];
  const result = await summarizer.summarize(story, draft.article, draft.comments, tagCatalog);
  assert.equal(result.generatedAt, '2026-09-18T08:00:00.000Z');
  assert.deepEqual(result.comments, draft.comments);
  assert.equal(result.commentCount, story.descendants);
  const request = JSON.parse(requestBody);
  const userPayload = JSON.parse(request.messages[1].content);
  assert.deepEqual(userPayload.tagCatalog, tagCatalog);
  assert.match(request.messages[0].content, /Tags are search handles, not broad categories/);
  assert.match(request.messages[0].content, /Never write raw comment IDs/);
});

test('OpenRouter summaries cannot cite comments that were not supplied', async () => {
  const forgedSummary: Summary = {
    ...summary,
    discussion: [{ heading: '伪造引用', text: '不存在的评论', commentIds: [999] }],
  };
  const http: JsonHttpClient = { request: async () => completion(forgedSummary) };
  const summarizer = new OpenRouterSummarizer(config, http, silentLogger);

  await assert.rejects(
    summarizer.summarize(story, draft.article, draft.comments, []),
    /cited an unknown comment/,
  );
});

test('OpenRouter summaries cannot embed raw comment IDs in prose', async () => {
  const summaryWithRawId: Summary = {
    ...summary,
    discussion: [{ heading: '直接引用', text: '评论 124 提出了修正', commentIds: [124] }],
  };
  const http: JsonHttpClient = { request: async () => completion(summaryWithRawId) };
  const summarizer = new OpenRouterSummarizer(config, http, silentLogger);

  await assert.rejects(
    summarizer.summarize(story, draft.article, draft.comments, []),
    /embedded a raw comment ID/,
  );
});

test('OpenRouter summaries cannot infer consensus from an unranked sample', async () => {
  const summaryWithConsensus: Summary = {
    ...summary,
    discussion: [{ heading: '过度概括', text: '大多数评论者都支持这一方案', commentIds: [124] }],
  };
  const http: JsonHttpClient = { request: async () => completion(summaryWithConsensus) };
  const summarizer = new OpenRouterSummarizer(config, http, silentLogger);

  await assert.rejects(
    summarizer.summarize(story, draft.article, draft.comments, []),
    /unsupported comment consensus/,
  );
});

test('OpenRouter summaries cannot invent article sections when extraction failed', async () => {
  const http: JsonHttpClient = {
    request: async () => completion(summary),
  };
  const summarizer = new OpenRouterSummarizer(config, http, silentLogger);

  await assert.rejects(
    summarizer.summarize(
      story,
      { text: '', source: 'unavailable', readingMinutes: null },
      draft.comments,
      [],
    ),
    /invented article sections/,
  );
});

test('reading summaries repair unsupported consensus once using validator feedback, without relaxing evidence checks', async () => {
  const invalid: Summary = {
    ...summary,
    discussion: [{ heading: '过度概括', text: '大多数评论者都支持这一方案', commentIds: [124] }],
  };
  const requests: string[] = [];
  const summarizer = new OpenRouterSummarizer(
    config,
    {
      request: async (_url, _service, init) => {
        assert.equal(typeof init?.body, 'string');
        requests.push(String(init?.body));
        return completion(requests.length === 1 ? invalid : summary);
      },
    },
    silentLogger,
  );
  const result = await summarizer.summarize(story, draft.article, draft.comments, [], true);
  assert.equal(requests.length, 2);
  assert.deepEqual(result.summary, summary);
  const correction = JSON.parse(requests[1] ?? '').messages;
  assert.match(correction[3].content, /unsupported comment consensus/);
  assert.deepEqual(JSON.parse(correction[2].content), invalid);

  let invalidCalls = 0;
  const stillInvalid = new OpenRouterSummarizer(
    config,
    {
      request: async () => {
        invalidCalls++;
        return completion(invalid);
      },
    },
    silentLogger,
  );
  await assert.rejects(
    stillInvalid.summarize(story, draft.article, draft.comments, [], true),
    /unsupported comment consensus/,
  );
  assert.equal(invalidCalls, 2);

  let failedCalls = 0;
  const unavailable = new OpenRouterSummarizer(
    config,
    {
      request: async () => {
        failedCalls++;
        throw new Error('network unavailable');
      },
    },
    silentLogger,
  );
  await assert.rejects(
    unavailable.summarize(story, draft.article, draft.comments, [], true),
    /network unavailable/,
  );
  assert.equal(failedCalls, 1);
});

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
  const http: JsonHttpClient = {
    request: async () => completion(summary),
  };
  const summarizer = new OpenRouterSummarizer(
    config,
    http,
    silentLogger,
    () => new Date('2026-09-18T08:00:00.000Z'),
  );

  const result = await summarizer.summarize(story, draft.article, draft.comments);
  assert.equal(result.generatedAt, '2026-09-18T08:00:00.000Z');
  assert.deepEqual(result.comments, draft.comments);
  assert.equal(result.commentCount, story.descendants);
});

test('OpenRouter summaries cannot cite comments that were not supplied', async () => {
  const forgedSummary: Summary = {
    ...summary,
    discussion: [{ heading: '伪造引用', text: '不存在的评论', commentIds: [999] }],
  };
  const http: JsonHttpClient = { request: async () => completion(forgedSummary) };
  const summarizer = new OpenRouterSummarizer(config, http, silentLogger);

  await assert.rejects(
    summarizer.summarize(story, draft.article, draft.comments),
    /cited an unknown comment/,
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
    ),
    /invented article sections/,
  );
});

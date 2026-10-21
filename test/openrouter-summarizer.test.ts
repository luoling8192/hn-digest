import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenRouterSummarizer } from '../src/adapters/openrouter-summarizer.js';
import type { Summary } from '../src/domain.js';
import { ApplicationError } from '../src/errors.js';
import type { JsonHttpClient } from '../src/http-client.js';
import { type LogFields, silentLogger } from '../src/logger.js';
import { config, draft, story, summary } from './fixtures.js';

function generatedSummary(summary: Summary) {
  return {
    ...summary,
    rewrite: summary.rewrite ?? {
      sections: summary.article.map((section) => ({ ...section, imageIds: [] })),
    },
  };
}

function completion(summary: Summary): unknown {
  return {
    choices: [
      {
        message: { content: JSON.stringify(generatedSummary(summary)) },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 200 },
  };
}

test('channel preview retains a separate source rewrite and supplied image references', async () => {
  const rewritten = {
    ...summary,
    rewrite: {
      sections: [{ heading: '芯片结构', paragraphs: ['原文的详细解释。'], imageIds: ['image-1'] }],
    },
  };
  const source = {
    ...draft.article,
    media: {
      coverImage: 'https://example.com/chip.jpg',
      images: [{ id: 'image-1', url: 'https://example.com/chip.jpg', caption: '芯片结构' }],
    },
  };
  let instructions = '';
  const summarizer = new OpenRouterSummarizer(
    config,
    {
      request: async (_url, _service, init) => {
        const request = JSON.parse(String(init?.body));
        instructions = request.messages[0].content;
        assert.ok(request.response_format.json_schema.schema.required.includes('rewrite'));
        assert.deepEqual(JSON.parse(request.messages[1].content).article.media, source.media);
        return completion(rewritten);
      },
    },
    silentLogger,
  );
  const result = await summarizer.summarize(story, source, draft.comments, []);
  assert.ok('rewrite' in result.summary);
  assert.deepEqual(result.summary.rewrite, rewritten.rewrite);
  assert.match(instructions, /rewrite.*Instant View/s);
  assert.match(instructions, /imageIds/);
});

test('new model output must include rewrite even though historical summaries may omit it', async () => {
  const summarizer = new OpenRouterSummarizer(
    config,
    {
      request: async () => ({
        choices: [{ message: { content: JSON.stringify(summary) }, finish_reason: 'stop' }],
      }),
    },
    silentLogger,
  );
  await assert.rejects(
    summarizer.summarize(story, draft.article, draft.comments, [], false),
    /rewrite/,
  );
});

test('low-value comment samples may be omitted instead of filling the digest', async () => {
  const comments = [
    { id: 124, parent: story.id, author: 'alice', text: 'Thanks for writing this!' },
    { id: 125, parent: story.id, author: 'bob', text: 'Please cover multiplication next.' },
    { id: 126, parent: story.id, author: 'carol', text: 'A small typo in the third paragraph.' },
  ];
  const selected: Summary = { ...summary, discussion: [] };
  let calls = 0;
  const summarizer = new OpenRouterSummarizer(
    config,
    {
      request: async () => {
        calls++;
        return completion(selected);
      },
    },
    silentLogger,
  );

  const result = await summarizer.summarize(story, draft.article, comments, []);
  assert.deepEqual(result.summary.discussion, []);
  assert.deepEqual(result.comments, comments);
  assert.equal(calls, 1);
});

test('readable article and HN text sources require a nonempty rewrite', async () => {
  const summarizer = new OpenRouterSummarizer(
    config,
    {
      request: async () => completion({ ...summary, rewrite: { sections: [] } }),
    },
    silentLogger,
  );

  for (const source of ['article', 'hn-text'] as const) {
    await assert.rejects(
      summarizer.summarize(story, { ...draft.article, source }, draft.comments, [], false),
      /omitted the readable article rewrite/,
    );
  }
});

test('sources without readable text allow an empty rewrite', async () => {
  const empty: Summary = {
    ...summary,
    quickTake: '原文正文暂时无法获取。',
    article: [],
    discussion: [],
    rewrite: { sections: [] },
  };
  const summarizer = new OpenRouterSummarizer(
    config,
    { request: async () => completion(empty) },
    silentLogger,
  );

  for (const source of ['article', 'hn-text', 'unavailable'] as const) {
    const result = await summarizer.summarize(
      story,
      { text: ' \n ', source, readingMinutes: null },
      [],
      [],
      false,
    );
    assert.ok('rewrite' in result.summary);
    assert.deepEqual(result.summary.rewrite, { sections: [] });
  }
});

test('a rewrite cannot cite an image absent from the retrieved article', async () => {
  const summarizer = new OpenRouterSummarizer(
    config,
    {
      request: async () =>
        completion({
          ...summary,
          rewrite: {
            sections: [{ heading: null, paragraphs: ['原文详细内容'], imageIds: ['invented'] }],
          },
        }),
    },
    silentLogger,
  );
  await assert.rejects(
    summarizer.summarize(story, draft.article, draft.comments, [], false),
    /unavailable image/,
  );
});

test('biodiversity report does not repeat HN discussion under the article summary', async () => {
  const discussion =
    '评论中有人补充了恢复的反例：北美鳕鱼渔场过度捕捞后虽被管制，但种群只稳定在远低于从前的水平，因为其他鱼类、水母等已占据了其生态位。';
  const contaminated: Summary = {
    ...summary,
    article: [{ heading: null, paragraphs: ['研究整合了423篇已发表研究。', discussion] }],
    discussion: [{ text: discussion.replaceAll('，', '， '), commentIds: [124] }],
  };
  const corrected: Summary = {
    ...contaminated,
    article: [{ heading: null, paragraphs: ['研究整合了423篇已发表研究。'] }],
  };
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const summarizer = new OpenRouterSummarizer(
    config,
    {
      request: async (_url, _service, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return completion(requests.length === 1 ? contaminated : corrected);
      },
    },
    silentLogger,
  );
  const result = await summarizer.summarize(story, draft.article, draft.comments, []);
  assert.equal(requests.length, 2);
  assert.match(requests[1]?.messages.at(-1)?.content ?? '', /duplicated discussion in article/);
  assert.deepEqual(result.summary.article, corrected.article);
  assert.deepEqual(result.summary.discussion, contaminated.discussion);
});

test('persistent article-discussion duplication is rejected after one repair', async () => {
  const text =
    '有人强调后果的时间成本：若更久是百万年，对人类并非好消息；当下与后代要承受森林消失期间的损失。';
  const contaminated: Summary = {
    ...summary,
    article: [{ heading: null, paragraphs: [text] }],
    discussion: [{ text, commentIds: [124] }],
  };
  let calls = 0;
  const summarizer = new OpenRouterSummarizer(
    config,
    {
      request: async () => {
        calls++;
        return completion(contaminated);
      },
    },
    silentLogger,
  );
  await assert.rejects(
    summarizer.summarize(story, draft.article, draft.comments, []),
    /duplicated discussion/,
  );
  assert.equal(calls, 2);
});

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
  assert.equal(request.max_tokens, 12_000);
  assert.deepEqual(request.reasoning, { enabled: false });
  const userPayload = JSON.parse(request.messages[1].content);
  assert.deepEqual(userPayload.tagCatalog, tagCatalog);
  assert.deepEqual(userPayload.discussionCoverage, {
    suppliedComments: 1,
    reportedComments: 10,
    missingParentIds: [],
  });
  assert.match(request.messages[0].content, /Tags are search handles, not broad categories/);
  assert.match(request.messages[0].content, /Do not write citation numbers, raw IDs/);
});

test('discussion evidence distinguishes submitters and exposes missing reply context', async () => {
  let payload: Record<string, unknown> = {};
  const comments = [
    ...draft.comments,
    { id: 125, parent: 999, author: 'submitter', text: 'I disagree with the missing context' },
    { id: 126, parent: 999, author: 'reader', text: 'Another reply' },
  ];
  const summarizer = new OpenRouterSummarizer(
    config,
    {
      request: async (_url, _service, init) => {
        const request = JSON.parse(String(init?.body));
        payload = JSON.parse(request.messages[1].content);
        return completion(summary);
      },
    },
    silentLogger,
  );
  const result = await summarizer.summarize(
    { ...story, by: 'submitter' },
    draft.article,
    comments,
    [],
  );
  assert.deepEqual(payload.story, { id: story.id, title: story.title, submitter: 'submitter' });
  assert.deepEqual(payload.discussionCoverage, {
    suppliedComments: 3,
    reportedComments: 10,
    missingParentIds: [999],
  });
  assert.deepEqual(result.comments, comments);
});

test('reasoning-only truncation reports the output limit without attempting evidence repair', async () => {
  let calls = 0;
  const events: LogFields[] = [];
  const summarizer = new OpenRouterSummarizer(
    { ...config, OPENROUTER_MAX_OUTPUT_TOKENS: 16_000 },
    {
      request: async (_url, _service, init) => {
        assert.equal(JSON.parse(String(init?.body)).max_tokens, 16_000);
        calls++;
        return {
          choices: [{ message: { content: null }, finish_reason: 'length' }],
          usage: {
            prompt_tokens: 500,
            completion_tokens: 16_000,
            completion_tokens_details: { reasoning_tokens: 16_000 },
          },
        };
      },
    },
    {
      ...silentLogger,
      info: (event, fields) => {
        if (event === 'summary_completion' && fields) events.push(fields);
      },
    },
  );
  await assert.rejects(
    summarizer.summarize(story, draft.article, draft.comments, []),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === 'summary_output_truncated',
  );
  assert.equal(calls, 1);
  assert.deepEqual(events, [
    {
      storyId: story.id,
      model: config.OPENROUTER_MODEL,
      finishReason: 'length',
      truncated: true,
      maxOutputTokens: 16_000,
      inputTokens: 500,
      outputTokens: 16_000,
      reasoningTokens: 16_000,
      correction: false,
    },
  ]);
});

test('empty model content cannot become a successful summary', async () => {
  const summarizer = new OpenRouterSummarizer(
    config,
    {
      request: async () => ({ choices: [{ message: { content: null }, finish_reason: 'stop' }] }),
    },
    silentLogger,
  );
  await assert.rejects(
    summarizer.summarize(story, draft.article, draft.comments, []),
    /no summary content/,
  );
});

test('OpenRouter summaries cannot cite comments that were not supplied', async () => {
  const forgedSummary: Summary = {
    ...summary,
    discussion: [{ text: '不存在的评论', commentIds: [999] }],
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
    discussion: [{ text: '评论 124 提出了修正', commentIds: [124] }],
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
    discussion: [{ text: '大多数评论者都支持这一方案', commentIds: [124] }],
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

test('channel summaries repair unsupported consensus by default once without relaxing evidence checks', async () => {
  const invalid: Summary = {
    ...summary,
    discussion: [{ text: '大多数评论者都支持这一方案', commentIds: [124] }],
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
  const result = await summarizer.summarize(story, draft.article, draft.comments, []);
  assert.equal(requests.length, 2);
  assert.deepEqual(result.summary, generatedSummary(summary));
  const correction = JSON.parse(requests[1] ?? '').messages;
  assert.match(correction.at(-1).content, /unsupported comment consensus/);
  assert.equal(correction.at(-2).role, 'assistant');
  assert.deepEqual(JSON.parse(correction.at(-2).content), generatedSummary(invalid));

  let invalidCalls = 0;
  const rejections: LogFields[] = [];
  const stillInvalid = new OpenRouterSummarizer(
    config,
    {
      request: async () => {
        invalidCalls++;
        return completion(invalid);
      },
    },
    {
      ...silentLogger,
      warn: (event, fields) => {
        if (event === 'summary_evidence_rejected' && fields) rejections.push(fields);
      },
    },
  );
  await assert.rejects(
    stillInvalid.summarize(story, draft.article, draft.comments, []),
    /unsupported comment consensus/,
  );
  assert.equal(invalidCalls, 2);
  assert.deepEqual(
    rejections,
    [false, true].map((correction) => ({
      storyId: story.id,
      code: 'summary_evidence_invalid',
      reason: 'Summary inferred unsupported comment consensus',
      correction,
    })),
  );

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
    unavailable.summarize(story, draft.article, draft.comments, []),
    /network unavailable/,
  );
  assert.equal(failedCalls, 1);
});

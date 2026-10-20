import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Article } from '../src/domain.js';
import { ApplicationError, errorCode, RemoteHttpError } from '../src/errors.js';
import { OpenRouterReadingAssistant } from '../src/recommendations/assistant.js';
import { articleFromCandidate } from '../src/recommendations/catalog.js';
import { newReader, type Candidate } from '../src/recommendations/model.js';

const candidate: Candidate = {
  id: 1,
  title: 'Engineering database internals',
  url: 'https://example.com/database',
  score: 200,
  comments: 10,
  time: 1_600_000_000,
  topics: ['架构'],
  status: 'pending',
  attemptedAt: null,
};
const source: Article = {
  text: 'The author measures database read and write performance. '.repeat(12),
  source: 'article',
  readingMinutes: 1,
};
const article = articleFromCandidate(candidate, source);
const annotation = {
  id: 1,
  title: '数据库内部实现',
  description: '作者比较了数据库的读写性能。',
  topics: ['架构', '数据库', '架构'],
  readable: true,
};
const config = { OPENROUTER_API_KEY: 'offline-fixture', OPENROUTER_MODEL: 'offline-fixture' };

function completion(content: string | null, finishReason = 'stop') {
  return { choices: [{ finish_reason: finishReason, message: { content } }] };
}

function annotateResponse(response: unknown) {
  return new OpenRouterReadingAssistant(config, { request: async () => response }).annotate(
    [article],
    newReader(100),
    new Map([[1, source]]),
  );
}

test('reading annotations preserve source evidence and apply grounded Chinese metadata', async () => {
  const [result] = await annotateResponse(completion(JSON.stringify({ articles: [annotation] })));
  assert.deepEqual(result, {
    ...article,
    title: annotation.title,
    description: annotation.description,
    topics: ['架构', '数据库'],
  });
});

test('an unreadable annotation has a distinct source rejection code', async () => {
  await assert.rejects(
    annotateResponse(
      completion(JSON.stringify({ articles: [{ ...annotation, readable: false }] })),
    ),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === 'reading_source_unreadable' &&
      error.status === 422,
  );
});

for (const [name, response, code] of [
  ['truncated output', completion('', 'length'), 'reading_response_truncated'],
  ['no choices', { choices: [] }, 'reading_response_empty'],
  ['null content', completion(null), 'reading_response_empty'],
  ['blank content', completion(' \n '), 'reading_response_empty'],
  ['invalid JSON', completion('{broken'), 'reading_response_invalid_json'],
  ['missing annotations', completion('{"articles":[]}'), 'reading_annotations_incomplete'],
  [
    'unknown annotation ID',
    completion(JSON.stringify({ articles: [{ ...annotation, id: 2 }] })),
    'reading_annotation_id_mismatch',
  ],
] as const) {
  test(`reading ${name} is classified without accepting the response`, async () => {
    await assert.rejects(
      annotateResponse(response),
      (error: unknown) => error instanceof ApplicationError && error.code === code,
    );
  });
}

test('duplicate IDs cannot replace the second requested annotation', async () => {
  const assistant = new OpenRouterReadingAssistant(config, {
    request: async () => completion(JSON.stringify({ articles: [annotation, annotation] })),
  });
  await assert.rejects(
    assistant.annotate(
      [article, { ...article, id: 2 }],
      newReader(100),
      new Map([
        [1, source],
        [2, source],
      ]),
    ),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === 'reading_annotations_incomplete',
  );
});

test('reading annotation schema validation still rejects invalid metadata', async () => {
  await assert.rejects(
    annotateResponse(completion(JSON.stringify({ articles: [{ ...annotation, topics: [] }] }))),
    (error: unknown) => errorCode(error) === 'invalid_remote_data',
  );
});

test('reading transport failures are classified and HTTP errors retain their status', async () => {
  for (const error of [
    new Error('Offline transport failed'),
    new RemoteHttpError('openrouter', 503),
  ]) {
    const assistant = new OpenRouterReadingAssistant(config, {
      request: async () => {
        throw error;
      },
    });
    await assert.rejects(
      assistant.annotate([article], newReader(100), new Map([[1, source]])),
      (caught: unknown) =>
        error instanceof RemoteHttpError
          ? caught === error && errorCode(caught) === 'openrouter_http_503'
          : caught instanceof ApplicationError && caught.code === 'reading_request_failed',
    );
  }
});

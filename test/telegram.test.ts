import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type FetchLike, TelegramClient } from '../src/adapters/telegram.js';
import { DeliveryRejectedError, DeliveryUncertainError, errorCode } from '../src/errors.js';
import { config, draft } from './fixtures.js';

const page = { path: 'test', url: 'https://telegra.ph/test' };

test('network failures produce an uncertain Telegram delivery outcome', async () => {
  const fetchImplementation: FetchLike = async () => {
    throw new Error('offline');
  };
  const client = new TelegramClient(config, fetchImplementation);
  await assert.rejects(client.send(draft, page), DeliveryUncertainError);
});

test('Telegram API rejections remain safe to retry', async () => {
  const fetchImplementation: FetchLike = async () =>
    new Response(JSON.stringify({ ok: false, error_code: 429, description: 'retry later' }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    });
  const client = new TelegramClient(config, fetchImplementation);
  await assert.rejects(client.send(draft, page), DeliveryRejectedError);
});

test('Telegram edit rejections retain distinct safe reasons and flood-control delay', async () => {
  const cases = [
    {
      status: 400,
      description: 'Bad Request: message to edit not found',
      code: 'telegram_message_not_found',
    },
    {
      status: 400,
      description: "Bad Request: message can't be edited",
      code: 'telegram_message_not_editable',
    },
    {
      status: 400,
      description: 'Bad Request: message is too long',
      code: 'telegram_message_too_long',
    },
    {
      status: 400,
      description: "Bad Request: can't parse entities: Unsupported start tag at byte offset 12",
      code: 'telegram_invalid_entities',
    },
    { status: 401, description: 'Unauthorized', code: 'telegram_unauthorized' },
    { status: 403, description: 'Forbidden: bot was kicked', code: 'telegram_forbidden' },
    {
      status: 429,
      description: 'Too Many Requests: retry after 123',
      code: 'telegram_rate_limited',
      retryAfterSeconds: 123,
    },
  ];

  for (const scenario of cases) {
    const client = new TelegramClient(
      config,
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error_code: scenario.status,
            description: scenario.description,
            ...(scenario.retryAfterSeconds === undefined
              ? {}
              : { parameters: { retry_after: scenario.retryAfterSeconds } }),
          }),
          { status: scenario.status },
        ),
    );
    await assert.rejects(client.edit(draft, page, 42), (error: unknown) => {
      assert.ok(error instanceof DeliveryRejectedError);
      assert.equal(errorCode(error), scenario.code);
      assert.deepEqual(error.metadata, {
        code: scenario.code,
        status: scenario.status,
        method: 'editMessageText',
        ...(scenario.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: scenario.retryAfterSeconds }),
      });
      assert.equal(error.message, `Telegram rejected request: ${scenario.code}`);
      return true;
    });
  }
});

test('unknown Telegram descriptions cannot leak credentials, URLs or payloads into errors', async () => {
  const sensitiveDescription = 'private https://example.test/token-secret user@example.test';
  const client = new TelegramClient(
    config,
    async () =>
      new Response(
        JSON.stringify({ ok: false, error_code: 400, description: sensitiveDescription }),
        { status: 400 },
      ),
  );
  await assert.rejects(client.edit(draft, page, 42), (error: unknown) => {
    assert.ok(error instanceof DeliveryRejectedError);
    assert.equal(errorCode(error), 'telegram_http_400');
    assert.deepEqual(error.metadata, {
      code: 'telegram_http_400',
      status: 400,
      method: 'editMessageText',
    });
    assert.equal(error.message, 'Telegram rejected request: telegram_http_400');
    assert.doesNotMatch(JSON.stringify(error), /token-secret|example\.test/);
    assert.doesNotMatch(String(error), /token-secret|example\.test/);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('Telegram API error codes take precedence over the HTTP response status', async () => {
  const client = new TelegramClient(
    config,
    async () => new Response(JSON.stringify({ ok: false, error_code: 403 }), { status: 200 }),
  );
  await assert.rejects(client.send(draft, page), (error: unknown) => {
    assert.ok(error instanceof DeliveryRejectedError);
    assert.equal(errorCode(error), 'telegram_forbidden');
    assert.deepEqual(error.metadata, {
      code: 'telegram_forbidden',
      status: 403,
      method: 'sendMessage',
    });
    return true;
  });
});

test('Telegram rejections without an API error code retain the HTTP status', async () => {
  const client = new TelegramClient(
    config,
    async () =>
      new Response(JSON.stringify({ ok: false, description: 'unknown rejection' }), {
        status: 418,
      }),
  );
  await assert.rejects(client.send(draft, page), (error: unknown) => {
    assert.ok(error instanceof DeliveryRejectedError);
    assert.equal(errorCode(error), 'telegram_http_418');
    assert.equal(error.metadata?.status, 418);
    return true;
  });
});

test('legacy delivery rejections remain compatible with existing callers', () => {
  const error = new DeliveryRejectedError('rate limited');
  assert.equal(errorCode(error), 'DeliveryRejectedError');
  assert.equal(error.message, 'rate limited');
  assert.equal(error.metadata, undefined);
});

test('server errors and invalid Telegram responses remain uncertain', async () => {
  const responses = [
    () => new Response(JSON.stringify({ ok: false, error_code: 500 }), { status: 500 }),
    () => new Response('invalid JSON', { status: 400 }),
    () => new Response(JSON.stringify({ error_code: 400 }), { status: 400 }),
  ];
  for (const response of responses) {
    const client = new TelegramClient(config, async () => response());
    await assert.rejects(client.edit(draft, page, 42), DeliveryUncertainError);
  }
});

test('editing an unchanged Telegram message is treated as success', async () => {
  const fetchImplementation: FetchLike = async () =>
    new Response(
      JSON.stringify({
        ok: false,
        error_code: 400,
        description: 'Bad Request: message is not modified',
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  const client = new TelegramClient(config, fetchImplementation);
  await client.edit(draft, page, 42);
});

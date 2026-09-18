import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TelegramClient, type FetchLike } from '../src/adapters/telegram.js';
import { DeliveryRejectedError, DeliveryUncertainError } from '../src/errors.js';
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

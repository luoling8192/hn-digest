import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type FetchLike, TelegramClient } from '../src/adapters/telegram.js';
import type { Draft } from '../src/domain.js';
import { DeliveryRejectedError, DeliveryUncertainError } from '../src/errors.js';
import { config, draft, summary } from './fixtures.js';

const page = { path: 'test', url: 'https://telegra.ph/test' };
const pictured: Draft = {
  ...draft,
  article: {
    ...draft.article,
    media: { coverImage: 'https://example.com/cover.jpg', images: [] },
  },
};

test('configured reading accounts enable real channel feedback on sends and edits', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const client = new TelegramClient({ ...config, TELEGRAM_OWNER_ID: 100 }, async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, result: { message_id: 42 } });
  });
  await client.send(draft, page);
  await client.edit(pictured, page, 42);
  for (const request of requests) {
    assert.deepEqual(request.reply_markup, {
      inline_keyboard: [
        [
          { text: '♡ 喜欢', callback_data: 'd:like:123' },
          { text: '☆ 收藏', callback_data: 'd:save:123' },
        ],
      ],
    });
  }
});

test('cover stories use sendMessage with a native Chinese reading preview and no URL button', async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const client = new TelegramClient(config, async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({ ok: true, result: { message_id: 42 } });
  });

  assert.equal(await client.send(pictured, page), 42);
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.ok(request);
  assert.ok(request.url.endsWith('/sendMessage'));
  const payload = request.body;
  assert.equal(payload.chat_id, config.TELEGRAM_CHAT_ID);
  assert.match(String(payload.text), /<blockquote expandable>/);
  assert.equal(payload.parse_mode, 'HTML');
  assert.deepEqual(payload.link_preview_options, {
    is_disabled: false,
    url: page.url,
    prefer_large_media: true,
    show_above_text: false,
  });
  assert.equal('photo' in payload, false);
  assert.equal('caption' in payload, false);
  assert.equal('reply_markup' in payload, false);
});

test('drafts without a cover use the same native Chinese reading preview', async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const client = new TelegramClient(config, async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({ ok: true, result: { message_id: 43 } });
  });

  assert.equal(await client.send(draft, page), 43);
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.ok(request);
  assert.ok(request.url.endsWith('/sendMessage'));
  assert.match(String(request.body.text), /<blockquote expandable>/);
  assert.deepEqual(request.body.link_preview_options, {
    is_disabled: false,
    url: page.url,
    prefer_large_media: true,
    show_above_text: false,
  });
  assert.equal('photo' in request.body, false);
});

test('cover story edits keep text delivery and its native reading preview in place', async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const client = new TelegramClient(config, async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({ ok: true, result: { message_id: 42 } });
  });

  await client.edit(pictured, page, 42);
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.ok(request);
  assert.ok(request.url.endsWith('/editMessageText'));
  assert.equal(request.body.message_id, 42);
  assert.match(String(request.body.text), /<blockquote expandable>/);
  assert.equal(request.body.parse_mode, 'HTML');
  assert.equal('media' in request.body, false);
  assert.deepEqual(request.body.link_preview_options, {
    is_disabled: false,
    url: page.url,
    prefer_large_media: true,
    show_above_text: false,
  });
  assert.deepEqual(request.body.reply_markup, { inline_keyboard: [] });
});

test('text edits explicitly clear an old custom URL keyboard when feedback is disabled', async () => {
  let payload: Record<string, unknown> = {};
  const client = new TelegramClient(config, async (_url, init) => {
    payload = JSON.parse(String(init?.body));
    return Response.json({ ok: true, result: { message_id: 42 } });
  });

  await client.edit(draft, page, 42);
  assert.deepEqual(payload.reply_markup, { inline_keyboard: [] });
});

test('cover stories above the photo caption limit still send and edit as text', async () => {
  const oversized: Draft = {
    ...pictured,
    summary: {
      ...summary,
      article: [{ heading: null, paragraphs: ['甲'.repeat(1100)] }],
    },
  };
  let calls = 0;
  const client = new TelegramClient(config, async () => {
    calls++;
    return Response.json({ ok: true, result: { message_id: 42 } });
  });
  assert.equal(await client.send(oversized, page), 42);
  await client.edit(oversized, page, 42);
  assert.equal(calls, 2);
});

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

test('photo-to-text mismatch does not delete, resend, or hide the API rejection', async () => {
  for (const input of [pictured, draft]) {
    const methods: string[] = [];
    const client = new TelegramClient(config, async (url) => {
      methods.push(String(url));
      return Response.json(
        {
          ok: false,
          error_code: 400,
          description: 'Bad Request: there is no text in the message to edit',
        },
        { status: 400 },
      );
    });
    await assert.rejects(client.edit(input, page, 42), DeliveryRejectedError);
    assert.equal(methods.length, 1);
    assert.ok(methods[0]?.endsWith('/editMessageText'));
  }
});

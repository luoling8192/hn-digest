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
  const client = new TelegramClient(
    { ...config, TELEGRAM_OWNER_ID: 100 },
    async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, result: { message_id: 42 } });
    },
    () => ({ likes: 0, saves: 0 }),
  );
  await client.send(draft, page);
  await client.edit(pictured, page, 42);
  for (const request of requests) {
    assert.deepEqual(request.reply_markup, {
      inline_keyboard: [
        [
          { text: '♡ 喜欢 0', callback_data: 'd:like:123' },
          { text: '☆ 收藏 0', callback_data: 'd:save:123' },
        ],
      ],
    });
  }
});

test('configured feedback requires a real count provider instead of silently showing zero', () => {
  assert.throws(
    () => new TelegramClient({ ...config, TELEGRAM_OWNER_ID: 100 }),
    /feedback count provider is required/i,
  );
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('channel sends and text edits read current aggregate counts from the provider', async () => {
  let counts = { likes: 12, saves: 8 };
  const requests: Array<Record<string, unknown>> = [];
  const stories: number[] = [];
  const client = new TelegramClient(
    { ...config, TELEGRAM_OWNER_ID: 100 },
    async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, result: { message_id: 42 } });
    },
    (storyId) => {
      stories.push(storyId);
      return counts;
    },
  );
  await client.send(draft, page);
  counts = { likes: 13, saves: 9 };
  await client.edit(draft, page, 42);
  assert.deepEqual(stories, [123, 123]);
  assert.deepEqual(
    requests.map((request) => request.reply_markup),
    [
      {
        inline_keyboard: [
          [
            { text: '♡ 喜欢 12', callback_data: 'd:like:123' },
            { text: '☆ 收藏 8', callback_data: 'd:save:123' },
          ],
        ],
      },
      {
        inline_keyboard: [
          [
            { text: '♡ 喜欢 13', callback_data: 'd:like:123' },
            { text: '☆ 收藏 9', callback_data: 'd:save:123' },
          ],
        ],
      },
    ],
  );
});

test('a pending keyboard update serializes a text edit and the edit reads counts when executed', async () => {
  const started = deferred<void>();
  const release = deferred<Response>();
  let counts = { likes: 1, saves: 0 };
  const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
  const client = new TelegramClient(
    { ...config, TELEGRAM_OWNER_ID: 100 },
    async (url, init) => {
      requests.push({
        method: new URL(String(url)).pathname.replace(/^.*\//, ''),
        body: JSON.parse(String(init?.body)),
      });
      if (requests.length === 1) {
        started.resolve();
        return release.promise;
      }
      return Response.json({ ok: true, result: { message_id: 42 } });
    },
    () => counts,
  );
  const keyboard = client.call('editMessageReplyMarkup', {
    chat_id: config.TELEGRAM_CHAT_ID,
    message_id: 42,
    reply_markup: {
      inline_keyboard: [
        [
          { text: '♡ 喜欢 1', callback_data: 'd:like:123' },
          { text: '☆ 收藏 0', callback_data: 'd:save:123' },
        ],
      ],
    },
  });
  await started.promise;
  const edit = client.edit(draft, page, 42);
  await Promise.resolve();
  assert.equal(requests.length, 1);
  counts = { likes: 2, saves: 3 };
  release.resolve(Response.json({ ok: true, result: true }));
  await Promise.all([keyboard, edit]);
  assert.deepEqual(
    requests.map((request) => request.method),
    ['editMessageReplyMarkup', 'editMessageText'],
  );
  assert.deepEqual(requests[1]?.body.reply_markup, {
    inline_keyboard: [
      [
        { text: '♡ 喜欢 2', callback_data: 'd:like:123' },
        { text: '☆ 收藏 3', callback_data: 'd:save:123' },
      ],
    ],
  });
});

test('failed message edits release the queue while other messages and methods stay independent', async () => {
  const started = deferred<void>();
  const release = deferred<Response>();
  const requests: Array<{ method: string; messageId: unknown }> = [];
  const client = new TelegramClient(config, async (url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push({
      method: new URL(String(url)).pathname.replace(/^.*\//, ''),
      messageId: body.message_id,
    });
    if (requests.length === 1) {
      started.resolve();
      return release.promise;
    }
    return Response.json({ ok: true, result: true });
  });
  const first = client.edit(draft, page, 42);
  const rejected = assert.rejects(first, DeliveryRejectedError);
  await started.promise;
  const queued = client.call('editMessageReplyMarkup', {
    chat_id: config.TELEGRAM_CHAT_ID,
    message_id: 42,
    reply_markup: { inline_keyboard: [] },
  });
  await client.edit(draft, page, 43);
  await client.call('answerCallbackQuery', { callback_query_id: 'callback' });
  assert.deepEqual(requests, [
    { method: 'editMessageText', messageId: 42 },
    { method: 'editMessageText', messageId: 43 },
    { method: 'answerCallbackQuery', messageId: undefined },
  ]);
  release.resolve(
    Response.json({ ok: false, error_code: 400, description: 'invalid edit' }, { status: 400 }),
  );
  await rejected;
  await queued;
  assert.deepEqual(requests.at(-1), { method: 'editMessageReplyMarkup', messageId: 42 });
});

test('only text and keyboard edits accept Telegram message-is-not-modified responses', async () => {
  const client = new TelegramClient(config, async () =>
    Response.json(
      {
        ok: false,
        error_code: 400,
        description: 'Bad Request: message is not modified',
      },
      { status: 400 },
    ),
  );
  await client.call('editMessageReplyMarkup', {
    chat_id: config.TELEGRAM_CHAT_ID,
    message_id: 42,
    reply_markup: { inline_keyboard: [] },
  });
  await assert.rejects(client.send(draft, page), DeliveryRejectedError);
  await assert.rejects(
    client.call('answerCallbackQuery', { callback_query_id: 'callback' }),
    DeliveryRejectedError,
  );
});

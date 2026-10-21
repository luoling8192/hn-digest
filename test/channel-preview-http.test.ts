import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createAdminServer } from '../src/admin-server.js';
import { configSchema } from '../src/config.js';
import { StoryNotFoundError } from '../src/errors.js';
import { silentLogger } from '../src/logger.js';
import { config, createHarness } from './fixtures.js';

test('channel preview binding requires admin authentication and an enabled capability', async () => {
  const harness = createHarness();
  const server = createAdminServer({
    adminToken: config.ADMIN_TOKEN,
    service: harness.service,
    logger: silentLogger,
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${port}/admin/channel-feedback/preview/123/5`;
    const unauthorized = await fetch(endpoint, { method: 'POST' });
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), { error: 'Unauthorized' });

    const unavailable = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.ADMIN_TOKEN}` },
    });
    assert.equal(unavailable.status, 404);
    assert.deepEqual(await unavailable.json(), { error: 'Not found' });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    harness.cleanup();
  }
});

test('channel preview binding validates URL IDs and passes no caller-supplied channel or draft', async () => {
  const harness = createHarness();
  const bindings: Array<[number, number]> = [];
  const server = createAdminServer({
    adminToken: config.ADMIN_TOKEN,
    service: harness.service,
    logger: silentLogger,
    bindChannelPreview: (storyId, messageId) => {
      if (storyId === 999) throw new StoryNotFoundError();
      bindings.push([storyId, messageId]);
    },
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}/admin/channel-feedback/preview`;
    const headers = { authorization: `Bearer ${config.ADMIN_TOKEN}` };

    const unauthorized = await fetch(`${base}/123/5`, { method: 'POST' });
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(bindings, []);

    const wrongMethod = await fetch(`${base}/123/5`, { headers });
    assert.equal(wrongMethod.status, 404);
    assert.deepEqual(bindings, []);

    for (const suffix of [
      '0/5',
      '-1/5',
      '1.5/5',
      'abc/5',
      '9007199254740992/5',
      '123/0',
      '123/-5',
      '123/1.5',
      '123/abc',
      '123/9007199254740992',
    ]) {
      const invalid = await fetch(`${base}/${suffix}`, { method: 'POST', headers });
      assert.equal(invalid.status, 400, suffix);
      assert.deepEqual(await invalid.json(), { error: 'invalid_preview_binding' }, suffix);
    }
    assert.deepEqual(bindings, []);

    const missingPublication = await fetch(`${base}/999/5`, { method: 'POST', headers });
    assert.equal(missingPublication.status, 404);
    assert.deepEqual(await missingPublication.json(), { error: 'story_not_found' });
    assert.deepEqual(bindings, []);

    const valid = await fetch(`${base}/50142449/5?chatId=-100999999`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: '-100999999', draft: { story: { id: 999 } } }),
    });
    assert.equal(valid.status, 200);
    assert.deepEqual(await valid.json(), { bound: true, storyId: 50142449, messageId: 5 });
    assert.deepEqual(bindings, [[50142449, 5]]);
    assert.deepEqual(harness.repository.listPublications(), []);
    assert.equal(harness.sends(), 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    harness.cleanup();
  }
});

test('preview chat configuration accepts only safe canonical channel IDs and preserves publishing target', () => {
  const environment = { ...config, AUTO_PUBLISH: 'false' };
  assert.equal(configSchema.parse(environment).TELEGRAM_PREVIEW_CHAT_ID, undefined);
  const configured = configSchema.parse({
    ...environment,
    TELEGRAM_PREVIEW_CHAT_ID: '-1004304069991',
  });
  assert.equal(configured.TELEGRAM_PREVIEW_CHAT_ID, '-1004304069991');
  assert.equal(configured.TELEGRAM_CHAT_ID, config.TELEGRAM_CHAT_ID);
  for (const id of [
    '',
    '4304069991',
    '-4304069991',
    '-1000',
    '-10001',
    '-1001.5',
    '-1009007199254740992',
  ]) {
    assert.equal(
      configSchema.safeParse({ ...environment, TELEGRAM_PREVIEW_CHAT_ID: id }).success,
      false,
      id,
    );
  }
});

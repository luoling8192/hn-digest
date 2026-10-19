import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createAdminServer } from '../src/admin-server.js';
import { silentLogger } from '../src/logger.js';
import { readyPublication } from '../src/domain.js';
import { config, createHarness, draft } from './fixtures.js';

test('admin HTTP boundary exposes health while protecting operational data', async () => {
  const harness = createHarness({ getItem: async () => null });
  const server = createAdminServer({
    adminToken: config.ADMIN_TOKEN,
    service: harness.service,
    logger: silentLogger,
    startedAt: '2026-09-18T00:00:00.000Z',
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });

    const unauthorized = await fetch(`${base}/admin/status`);
    assert.equal(unauthorized.status, 401);

    const headers = { authorization: `Bearer ${config.ADMIN_TOKEN}` };
    const status = await fetch(`${base}/admin/status`, { headers });
    assert.equal(status.status, 200);
    const body = (await status.json()) as {
      publications: unknown[];
      startedAt: string;
      currentWork: unknown;
    };
    assert.equal(body.startedAt, '2026-09-18T00:00:00.000Z');
    assert.deepEqual(body.publications, []);
    assert.equal(body.currentWork, null);

    const missing = await fetch(`${base}/admin/publish/999`, { method: 'POST', headers });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'story_not_found' });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    harness.cleanup();
  }
});

test('admin status separates missing article sources from publication failures without exposing text', async () => {
  const harness = createHarness();
  const server = createAdminServer({
    adminToken: config.ADMIN_TOKEN,
    service: harness.service,
    logger: silentLogger,
  });
  try {
    harness.repository.savePublication({
      ...readyPublication(
        { ...draft, article: { text: '', source: 'unavailable', readingMinutes: null } },
        harness.runtime.now(),
      ),
      state: 'published',
      page: { path: 'existing', url: 'https://telegra.ph/existing' },
      messageId: 42,
    });
    harness.repository.setSetting(
      `article_recovery:${draft.story.id}`,
      JSON.stringify({
        attempts: 2,
        lastAttempt: harness.runtime.now(),
        nextRetry: harness.runtime.now() + 600_000,
        article: null,
        lastError: 'article_recovery_unavailable',
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/admin/status`, {
      headers: { authorization: `Bearer ${config.ADMIN_TOKEN}` },
    });
    const body = (await response.json()) as {
      publications: { articleSource: string; articleCharacters: number }[];
      articleRecoveries: unknown[];
      failures: unknown[];
    };
    assert.equal(body.publications[0]?.articleSource, 'unavailable');
    assert.equal(body.publications[0]?.articleCharacters, 0);
    assert.deepEqual(body.failures, []);
    assert.deepEqual(body.articleRecoveries, [
      {
        id: draft.story.id,
        attempts: 2,
        nextRetry: harness.runtime.now() + 600_000,
        code: 'article_recovery_unavailable',
        phase: 'source',
      },
    ]);
    assert.equal(JSON.stringify(body).includes('Article text'), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    harness.cleanup();
  }
});

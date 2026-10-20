import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TelegramClient } from '../src/adapters/telegram.js';
import { DigestService } from '../src/application/digest-service.js';
import { type LogFields, silentLogger } from '../src/logger.js';
import { config, createHarness, draft, story } from './fixtures.js';

for (const event of ['publication_failed', 'refresh_failed', 'article_recovery_failed'] as const) {
  test(`${event} retains safe Telegram diagnostics without exposing response text`, async () => {
    let requests = 0;
    const telegram = new TelegramClient(config, async () => {
      requests++;
      return Response.json(
        {
          ok: false,
          error_code: 429,
          description: 'Too Many Requests: retry after 123 RESPONSE_TEXT_MUST_NOT_BE_LOGGED',
          parameters: { retry_after: 123 },
        },
        { status: 429 },
      );
    });
    const harness = createHarness();
    const events: { event: string; fields: LogFields | undefined }[] = [];
    const logger = {
      ...silentLogger,
      error: (event: string, fields?: LogFields) => events.push({ event, fields }),
      warn: (event: string, fields?: LogFields) => events.push({ event, fields }),
    };
    try {
      harness.dependencies.summarize = async (story, article) => ({
        ...structuredClone(draft),
        story,
        article,
      });
      if (event !== 'publication_failed') {
        if (event === 'article_recovery_failed') {
          harness.dependencies.extractArticle = async () => ({
            text: '',
            source: 'unavailable',
            readingMinutes: null,
          });
        }
        await harness.service.publish(story.id);
        harness.runtime.advance(600_000);
        harness.dependencies.extractArticle = async () => draft.article;
        harness.dependencies.getTopStories = async () =>
          event === 'refresh_failed' ? [{ ...story, score: 201 }] : [];
      }
      harness.dependencies.sendMessage = (draft, page) => telegram.send(draft, page);
      harness.dependencies.editMessage = (draft, page, id) => telegram.edit(draft, page, id);
      const service = new DigestService(
        config,
        harness.repository,
        harness.dependencies,
        logger,
        harness.runtime,
      );

      assert.equal((await service.runCycle()).failed, 1);
      assert.equal(requests, 1);
      const entry = events.find((entry) => entry.event === event);
      assert.deepEqual(entry?.fields, {
        storyId: story.id,
        ...(event === 'article_recovery_failed'
          ? {
              phase: 'edit_message',
              attempts: 1,
              nextRetry: harness.runtime.now() + 600_000,
            }
          : {}),
        code: 'telegram_rate_limited',
        telegramMethod: event === 'publication_failed' ? 'sendMessage' : 'editMessageText',
        telegramStatus: 429,
        retryAfterSeconds: 123,
      });
      if (event === 'article_recovery_failed') {
        assert.equal(service.articleRecoveries()[0]?.code, 'telegram_rate_limited');
      } else {
        assert.equal(harness.repository.listFailures()[0]?.code, 'telegram_rate_limited');
      }
      assert.equal(
        harness.repository.getPublication(story.id)?.state,
        event === 'publication_failed' ? 'ready' : 'published',
      );
      assert.doesNotMatch(
        JSON.stringify(events),
        /RESPONSE_TEXT_MUST_NOT_BE_LOGGED|test-token-not-a-real-token|api\.telegram\.org/,
      );
    } finally {
      harness.cleanup();
    }
  });
}

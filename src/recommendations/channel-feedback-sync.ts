import { z } from 'zod';
import { channelFeedbackMarkup } from '../presentation.js';
import type { ChannelFeedbackOptions } from './channel-feedback.js';
import type { ReadingTransport } from './service.js';
import type { ReadingStore } from './store.js';

export class ChannelFeedbackSync {
  private operation: Promise<void> = Promise.resolve();
  private readonly retryAt = new Map<number, number>();

  constructor(
    private readonly options: ChannelFeedbackOptions,
    private readonly store: ReadingStore,
    private readonly transport: ReadingTransport,
    private readonly now: () => number,
  ) {}

  sync(signal?: AbortSignal): Promise<void> {
    const operation = this.operation.then(() => this.flush(signal));
    this.operation = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }

  private async flush(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    const seedKey = `feedback-counts:seeded:${this.options.chatId}`;
    if (this.store.get(seedKey, z.literal(true)) === null) {
      this.store.transaction(() => {
        for (const publication of this.options.publications.listPublications()) {
          if (publication.state === 'published' && publication.page && publication.messageId) {
            this.store.markFeedbackCounts(publication.id);
          }
        }
        this.store.put(seedKey, true);
      });
    }
    const errors: unknown[] = [];
    for (let processed = 0; processed < 20; processed++) {
      if (signal?.aborted) return;
      const pending = this.store
        .pendingFeedbackCounts()
        .find((item) => (this.retryAt.get(item.storyId) ?? 0) <= this.now());
      if (!pending) break;
      const { storyId, revision } = pending;
      const publication = this.options.publications.getPublication(storyId);
      if (
        (publication?.state === 'sending' || publication?.state === 'uncertain') &&
        publication.id === storyId &&
        publication.draft.story.id === storyId
      ) {
        this.retryAt.set(storyId, this.now() + 30_000);
        continue;
      }
      if (
        publication?.state !== 'published' ||
        !publication.page ||
        !publication.messageId ||
        publication.id !== storyId ||
        publication.draft.story.id !== storyId
      ) {
        this.store.ackFeedbackCounts(storyId, revision);
        continue;
      }
      const targets = [
        { chatId: this.options.chatId, messageId: publication.messageId },
        ...this.store
          .channelPreviewBindings()
          .filter(
            (binding) =>
              binding.storyId === storyId &&
              binding.chatId === this.options.previewChatId &&
              binding.chatId !== this.options.chatId,
          ),
      ];
      try {
        const replyMarkup = channelFeedbackMarkup(storyId, this.store.feedbackCounts(storyId));
        const targetErrors: unknown[] = [];
        for (const target of targets) {
          if (signal?.aborted) return;
          try {
            await this.transport.call(
              'editMessageReplyMarkup',
              {
                chat_id: target.chatId,
                message_id: target.messageId,
                reply_markup: replyMarkup,
              },
              signal,
            );
          } catch (error) {
            if (signal?.aborted) return;
            targetErrors.push(error);
          }
        }
        if (signal?.aborted) return;
        if (targetErrors.length) {
          this.retryAt.set(storyId, this.now() + 30_000);
          errors.push(...targetErrors);
          continue;
        }
        this.store.ackFeedbackCounts(storyId, revision);
        this.retryAt.delete(storyId);
      } catch (error) {
        this.retryAt.set(storyId, this.now() + 30_000);
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Channel feedback counts sync failed');
  }
}

import { z } from 'zod';
import type { Publication } from '../domain.js';
import { PublicationConflictError, StoryNotFoundError } from '../errors.js';
import type { PublicationRepository } from '../storage/publication-repository.js';
import { syncPublishedArticle } from './catalog.js';
import { newReader } from './model.js';
import { feedbackFor } from './ranking.js';
import type { ReadingTransport, ReadingUpdate } from './service.js';
import type { ReadingStore } from './store.js';

export interface ChannelFeedbackOptions {
  chatId: string;
  publications: Pick<PublicationRepository, 'getPublication' | 'listPublications'>;
  previewChatId?: string;
}

const previewBindingSchema = z.object({ storyId: z.number().int().positive().safe() });

export function bindChannelFeedbackPreview(
  options: ChannelFeedbackOptions,
  store: ReadingStore,
  storyId: number,
  messageId: number,
): void {
  if (!options.previewChatId || options.previewChatId === options.chatId) {
    throw new PublicationConflictError('A separate preview channel is required');
  }
  if (
    !Number.isSafeInteger(storyId) ||
    storyId <= 0 ||
    !Number.isSafeInteger(messageId) ||
    messageId <= 0
  ) {
    throw new PublicationConflictError('Preview identifiers must be positive integers');
  }
  const publication = options.publications.getPublication(storyId);
  if (!publication) throw new StoryNotFoundError();
  if (publication.state !== 'published' || !publication.page) {
    throw new PublicationConflictError('Preview feedback requires a published story');
  }
  store.transaction(() => {
    store.put(`channel-preview:${options.previewChatId}:${messageId}`, { storyId });
    store.markFeedbackCounts(storyId);
  });
}

const receiptSchema = z.object({
  userId: z.number().int().positive(),
  storyId: z.number().int().positive(),
  messageId: z.number().int().positive(),
  action: z.enum(['like', 'save']),
  text: z.string(),
});

interface ChannelInteraction {
  chatId: string;
  callbackId: string;
  userId: number;
  storyId: number;
  messageId: number;
  action: 'like' | 'save';
  publication: Publication;
}

export class ChannelFeedback {
  constructor(
    private readonly options: ChannelFeedbackOptions,
    private readonly store: ReadingStore,
    private readonly transport: ReadingTransport,
    private readonly now: () => number,
  ) {}

  accepts(update: ReadingUpdate): boolean {
    return this.interaction(update) !== null;
  }

  refreshSavedArticles(storyIds: number[]): void {
    for (const storyId of storyIds) {
      const publication = this.options.publications.getPublication(storyId);
      if (publication?.state !== 'published' || !publication.page) continue;
      syncPublishedArticle(this.store, publication);
    }
  }

  async handle(update: ReadingUpdate): Promise<void> {
    const interaction = this.interaction(update);
    if (!interaction) return;
    const text = this.apply(interaction);
    await this.transport.call('answerCallbackQuery', {
      callback_query_id: interaction.callbackId,
      text,
    });
  }

  private interaction(update: ReadingUpdate): ChannelInteraction | null {
    const callback = update.callback_query;
    const message = callback?.message;
    if (
      !callback?.id ||
      callback.from.is_bot ||
      !Number.isSafeInteger(callback.from.id) ||
      message?.chat.type !== 'channel'
    ) {
      return null;
    }
    const match = callback.data?.match(/^d:(like|save):([1-9]\d*)$/);
    if (!match) return null;
    const storyId = Number(match[2]);
    if (!Number.isSafeInteger(storyId)) return null;
    const publication = this.options.publications.getPublication(storyId);
    const chatId = String(message.chat.id);
    const bound =
      chatId === this.options.chatId
        ? publication?.messageId === message.message_id
        : chatId === this.options.previewChatId &&
          this.store.get(`channel-preview:${chatId}:${message.message_id}`, previewBindingSchema)
            ?.storyId === storyId;
    if (
      publication?.state !== 'published' ||
      !publication.page ||
      publication.id !== storyId ||
      publication.draft.story.id !== storyId ||
      !bound
    ) {
      return null;
    }
    return {
      chatId,
      callbackId: callback.id,
      userId: callback.from.id,
      storyId,
      messageId: message.message_id,
      action: match[1] === 'like' ? 'like' : 'save',
      publication,
    };
  }

  private apply(interaction: ChannelInteraction): string {
    let text = '';
    this.store.transaction(() => {
      const { chatId, callbackId, userId, storyId, messageId, action, publication } = interaction;
      const key = `channel-feedback:${chatId}:${callbackId}`;
      const previous = this.store.get(key, receiptSchema);
      if (previous) {
        if (
          previous.userId !== userId ||
          previous.storyId !== storyId ||
          previous.messageId !== messageId ||
          previous.action !== action
        ) {
          throw new Error('Channel feedback callback identity mismatch');
        }
        text = previous.text;
        return;
      }
      const reader = this.store.reader(userId) ?? newReader(userId);
      const feedback = { ...feedbackFor(reader, storyId) };
      if (action === 'like') {
        feedback.opinion = feedback.opinion === 1 ? 0 : 1;
        text = feedback.opinion === 1 ? '已喜欢。' : '已取消喜欢。';
      } else {
        feedback.saved = !feedback.saved;
        if (feedback.saved) feedback.savedAt = this.now();
        text = feedback.saved ? '已收藏，私聊 Bot 发送 /saved 查看。' : '已取消收藏。';
      }
      feedback.revision += 1;
      reader.feedback[storyId] = feedback;
      syncPublishedArticle(this.store, publication);
      this.store.saveReader(reader);
      this.store.put(key, { userId, storyId, messageId, action, text });
    });
    return text;
  }
}

import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { escapeHtml } from '../presentation.js';
import { ReadingAccess } from './access.js';
import type { ReadingAssistant } from './assistant.js';
import { ChannelFeedback, type ChannelFeedbackOptions } from './channel-feedback.js';
import type { DeepReader } from './deep-reading.js';
import { ReadingLimits } from './limits.js';
import {
  type Batch,
  newReader,
  type Reader,
  type ReadingArticle,
  type ReadingCommand,
} from './model.js';
import { type ReadingMessage, readingMessage, renderBatch } from './presentation.js';
import { feedbackFor, recommend } from './ranking.js';
import type { StatusView } from './status.js';
import type { ReadingStore } from './store.js';

const userSchema = z.object({ id: z.number().int().positive(), is_bot: z.boolean() });
const messageSchema = z.object({
  message_id: z.number().int().positive(),
  chat: z.object({ id: z.number().int(), type: z.string() }),
  from: userSchema.optional(),
  text: z.string().optional(),
  reply_to_message: z.object({ message_id: z.number().int().positive() }).optional(),
});
export const readingUpdateSchema = z.object({
  update_id: z.number().int(),
  message: messageSchema.optional(),
  callback_query: z
    .object({
      id: z.string(),
      from: userSchema,
      data: z.string().optional(),
      message: messageSchema.optional(),
    })
    .optional(),
});
export type ReadingUpdate = z.infer<typeof readingUpdateSchema>;
export interface ReadingTransport {
  call(method: string, payload: object, signal?: AbortSignal): Promise<unknown>;
}
export interface Catalog {
  refresh(reader: Reader): Promise<void>;
}
const sentSchema = z.object({ message_id: z.number().int().positive() });
type FeedbackAction = 'save' | 'like' | 'less' | 'unsave';
const savedCommand = /^(\/saved(?:@\w+)?|\/start(?:@\w+)?\s+saved|我的收藏|收藏夹)$/;
const recommendationCommand = /^(\/recommend(?:@\w+)?|推荐|再来(?:\s*5\s*篇)?|再来几篇|给我推荐)$/;
const publicCommand =
  /^(\/start(?:@\w+)?(?:\s.*)?|\/help(?:@\w+)?|帮助|\/saved(?:@\w+)?|我的收藏|收藏夹)$/;

export class ReadingService {
  private operation: Promise<void> = Promise.resolve();
  private readonly access: ReadingAccess;
  private readonly limits: ReadingLimits;
  private lastPublicCatalogRefreshAt: number | null = null;
  private readonly channelFeedback: ChannelFeedback | undefined;
  constructor(
    readonly ownerId: number,
    private readonly store: ReadingStore,
    private readonly transport: ReadingTransport,
    private readonly catalog: Catalog,
    private readonly assistant: ReadingAssistant,
    private readonly now: () => number = Date.now,
    private readonly deepReader?: DeepReader,
    private readonly statusPanel?: (view: StatusView) => ReadingMessage,
    channelFeedback?: ChannelFeedbackOptions,
  ) {
    this.access = new ReadingAccess(ownerId, store, transport);
    this.limits = new ReadingLimits(store, now);
    this.channelFeedback = channelFeedback
      ? new ChannelFeedback(channelFeedback, store, transport, now)
      : undefined;
  }

  accepts(update: ReadingUpdate): boolean {
    if (update.callback_query?.data?.startsWith('d:')) {
      return this.channelFeedback?.accepts(update) === true;
    }
    const from = update.callback_query?.from ?? update.message?.from;
    const message = update.callback_query?.message ?? update.message;
    return (
      from !== undefined &&
      !from.is_bot &&
      message?.chat.type === 'private' &&
      message.chat.id === from.id &&
      (this.access.allowed(from.id) ||
        update.message?.text?.trim() === '/id' ||
        savedCommand.test(update.message?.text?.trim() ?? '') ||
        recommendationCommand.test(update.message?.text?.trim() ?? '') ||
        publicCommand.test(update.message?.text?.trim() ?? '') ||
        this.publicBatchCallback(update, from.id) !== null)
    );
  }

  isImmediate(update: ReadingUpdate): boolean {
    return update.callback_query?.data?.startsWith('d:') === true && this.accepts(update);
  }

  async handle(update: ReadingUpdate): Promise<void> {
    if (!this.accepts(update)) return;
    const userId = update.callback_query?.from.id ?? update.message?.from?.id;
    if (userId === undefined) return;
    if (!this.access.allowed(userId)) {
      const limit = this.limits.admitPublicAction(userId);
      if (!limit.allowed) {
        const text = limit.notify
          ? `${limit.reason === 'global' ? '现在使用的人较多' : '操作有点频繁'}，请 ${limit.retryAfterSeconds} 秒后再试。`
          : undefined;
        if (update.callback_query) {
          await this.transport.call('answerCallbackQuery', {
            callback_query_id: update.callback_query.id,
            ...(text ? { text } : {}),
          });
        } else if (text) {
          await this.send(newReader(userId), readingMessage(text), true);
        }
        return;
      }
    }
    if (update.callback_query?.data?.startsWith('d:')) {
      await this.channelFeedback?.handle(update);
      return;
    }
    const text = update.message?.text?.trim();
    const callback = update.callback_query;
    if (text === '/id') {
      await this.transport.call('sendMessage', {
        chat_id: userId,
        text: `你的 Telegram UID：${userId}`,
      });
      return;
    }
    if (await this.access.handle(update)) return;
    const statusCommand =
      text !== undefined && /^(\/status(?:@\w+)?|运行状态|状态面板)$/.test(text);
    const view = callback?.data?.match(/^ops:(overview|failures)$/)?.[1] as StatusView | undefined;
    if (statusCommand || view) {
      if (userId !== this.ownerId) return;
      if (callback) {
        await this.transport.call('answerCallbackQuery', { callback_query_id: callback.id });
      }
      const panel = this.statusPanel
        ? this.statusPanel(view ?? 'overview')
        : readingMessage('运行状态面板尚未配置。');
      await this.transport.call(callback ? 'editMessageText' : 'sendMessage', {
        chat_id: this.ownerId,
        ...(callback?.message ? { message_id: callback.message.message_id } : {}),
        ...panel,
      });
      return;
    }
    return this.serial(async () => {
      if (this.access.allowed(userId)) await this.handleAuthorized(update, userId);
      else await this.handlePublic(update, userId);
    });
  }

  private publicBatchCallback(update: ReadingUpdate, userId: number) {
    const callback = update.callback_query;
    const match = callback?.data?.match(
      /^r:([a-f0-9]{12}):(select(?::[1-5])|clear|save|like|less|unsave|undo|saved|more|next|prev)$/,
    );
    if (!match || !callback?.message) return null;
    const batch = this.store.batch(match[1] ?? '');
    if (!batch || batch.userId !== userId || batch.messageId !== callback.message.message_id)
      return null;
    const [action, number] = (match[2] ?? '').split(':');
    if (batch.kind !== 'saved' && ['unsave', 'next', 'prev'].includes(action ?? '')) return null;
    return { batch, action: action ?? '', number: number ? Number(number) : null };
  }

  private async handlePublic(update: ReadingUpdate, userId: number): Promise<void> {
    const reader = this.store.reader(userId) ?? newReader(userId);
    const callback = this.publicBatchCallback(update, userId);
    if (callback && update.callback_query) {
      await this.transport.call('answerCallbackQuery', {
        callback_query_id: update.callback_query.id,
      });
      await this.handleButton(reader, callback.batch, callback.action, callback.number);
      return;
    }
    const text = update.message?.text?.trim() ?? '';
    if (savedCommand.test(text)) {
      await this.showSaved(reader, 0);
    } else if (recommendationCommand.test(text)) {
      const message = update.message;
      const batch = message?.reply_to_message
        ? this.store.batchForMessage(userId, message.reply_to_message.message_id)
        : reader.latestBatch
          ? this.store.batch(reader.latestBatch)
          : null;
      if (batch?.selected.length) await this.askToFinishSelection(reader);
      else await this.sendRecommendations(reader);
    } else if (publicCommand.test(text)) {
      await this.send(
        reader,
        readingMessage(
          '欢迎使用拾光。\n\n发送 /recommend 或“推荐”，从已整理的文章中为你挑选 5 篇。公开推荐每 30 秒一批，每天最多 20 批。\n发送 /saved 或“我的收藏”，查看和管理你的收藏。\n在频道或清单里点击喜欢、收藏，逐步调整你的推荐；再次点击频道按钮即可取消。\n\n推荐和收藏向所有读者开放。AI 问答、深入阅读与自然语言偏好调整由管理员按用户开通。',
        ),
        true,
      );
    }
  }

  async sendPreview(): Promise<void> {
    return this.serial(async () => {
      const reader = this.store.reader(this.ownerId) ?? newReader(this.ownerId);
      this.store.saveReader(reader);
      await this.sendRecommendations(reader);
    });
  }

  accessStatus() {
    return {
      ownerOnlyAdmin: true,
      enabledReaders: 1 + this.access.grants().filter((g) => g.enabled).length,
      statusPanel: this.statusPanel !== undefined,
    };
  }

  resumeDeepReading(): void {
    for (const userId of [
      this.ownerId,
      ...this.access
        .grants()
        .filter((g) => g.enabled)
        .map((g) => g.userId),
    ]) {
      const reader = this.store.reader(userId);
      const batch = reader?.latestBatch ? this.store.batch(reader.latestBatch) : null;
      if (batch?.messageId) this.prepareBatch(batch);
    }
  }

  private serial(run: () => Promise<void>): Promise<void> {
    const operation = this.operation.then(run);
    this.operation = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }

  private async handleAuthorized(update: ReadingUpdate, userId: number): Promise<void> {
    const reader = this.store.reader(userId) ?? newReader(userId);
    this.store.saveReader(reader);
    if (update.callback_query) {
      const callback = update.callback_query;
      await this.transport.call('answerCallbackQuery', { callback_query_id: callback.id });
      if (!this.access.allowed(userId)) {
        const saved = this.publicBatchCallback(update, userId);
        if (saved) await this.handleButton(reader, saved.batch, saved.action, saved.number);
        return;
      }
      const match = callback.data?.match(/^r:([a-f0-9]{12}):([a-z]+)(?::([1-5]))?$/);
      if (!match || !callback.message) return;
      const batch = this.store.batch(match[1] ?? '');
      if (
        !batch ||
        batch.userId !== reader.userId ||
        batch.messageId !== callback.message.message_id
      )
        return;
      await this.handleButton(reader, batch, match[2] ?? '', match[3] ? Number(match[3]) : null);
      return;
    }
    const message = update.message;
    if (!message?.text) return;
    const text = message.text.trim();
    if (text.length > 2000) {
      await this.send(reader, readingMessage('这段有点长，请缩短到 2000 字以内。'));
      return;
    }
    if (savedCommand.test(text)) {
      await this.showSaved(reader, 0);
      return;
    }
    const repliedBatch = message.reply_to_message
      ? this.store.batchForMessage(reader.userId, message.reply_to_message.message_id)
      : null;
    const batch = message.reply_to_message
      ? repliedBatch
      : reader.latestBatch
        ? this.store.batch(reader.latestBatch)
        : null;
    if (/^\/start(?:@\w+)?(?:\s.*)?$/.test(text)) {
      await this.send(
        reader,
        readingMessage(
          `账号已绑定到当前 Telegram 用户。\n\n当前兴趣：${escapeHtml(
            reader.interests
              .filter((i) => i.weight > 0)
              .map((i) => i.name)
              .join('、') || '尚未设置',
          )}。\n你可以说“我更喜欢数据库和工程复盘”，也可以回复清单说“收藏 2、4”。`,
        ),
      );
      await this.sendRecommendations(reader);
      return;
    }
    if (recommendationCommand.test(text)) {
      if (batch?.selected.length) {
        await this.askToFinishSelection(reader);
        return;
      }
      await this.sendRecommendations(reader);
      return;
    }
    if (/^(\/preferences|我的偏好|调整方向)$/.test(text)) {
      await this.showPreferences(reader);
      return;
    }
    if (/^(\/help(?:@\w+)?|帮助)$/.test(text)) {
      await this.send(
        reader,
        readingMessage(
          `${reader.userId === this.ownerId ? '发送 /status 查看运行状态，/users 管理 AI 功能授权。\n' : ''}发送 /id 查看自己的 UID。\n发送“推荐”获取 5 篇；点编号后可批量收藏、反馈。\n发送“我的收藏”查看待读；发送“我的偏好”调整兴趣。\n回复清单说“收藏 2、4”或“聊聊第 2 篇”也可以。`,
        ),
      );
      return;
    }
    const quickAction = text.match(/^(收藏|喜欢|少推荐)\s*([1-5](?:[、,，\s]+[1-5])*)\s*$/);
    if (quickAction) {
      const action =
        quickAction[1] === '收藏' ? 'save' : quickAction[1] === '喜欢' ? 'like' : 'less';
      const selection = (quickAction[2] ?? '').match(/[1-5]/g)?.map(Number) ?? [];
      await this.commandAction(reader, batch, action, selection);
      return;
    }
    const articles = batch ? this.articlesFor(batch) : [];
    if (!batch && reader.focusedArticle) {
      const focused = this.store.article(reader.focusedArticle);
      if (focused) articles.push(focused);
    }
    await this.transport.call('sendChatAction', { chat_id: reader.userId, action: 'typing' });
    if (!this.access.allowed(userId)) return;
    const command = await this.assistant.understand(text, reader, articles);
    if (!this.access.allowed(userId)) return;
    await this.executeCommand(reader, batch, command, text);
    reader.history = [
      ...reader.history,
      { role: 'user' as const, content: text },
      { role: 'assistant' as const, content: command.reply },
    ].slice(-6);
    this.store.saveReader(reader);
  }

  async reportFailure(update?: ReadingUpdate): Promise<void> {
    if (update?.callback_query?.message?.chat.type === 'channel') {
      await this.transport.call('answerCallbackQuery', {
        callback_query_id: update.callback_query.id,
        text: '操作状态可能已保存，请私聊 Bot 发送 /saved 核对；再次点击会切换状态。',
        show_alert: true,
      });
      return;
    }
    const userId = update
      ? (update.callback_query?.from.id ?? update.message?.from?.id)
      : this.ownerId;
    if (userId === undefined || (update && !this.accepts(update))) return;
    const allowed = this.access.allowed(userId);
    if (
      !allowed &&
      (!update ||
        (!savedCommand.test(update.message?.text?.trim() ?? '') &&
          !recommendationCommand.test(update.message?.text?.trim() ?? '') &&
          this.publicBatchCallback(update, userId) === null))
    )
      return;
    await this.send(
      newReader(userId),
      readingMessage(
        allowed
          ? '这次操作没有完整完成。可以重试按钮，或发送“推荐”重新获取；已经保存的收藏会保留。'
          : '这次操作没有完整完成。请发送 /saved 核对收藏，或发送 /recommend 重新获取推荐；已经保存的收藏会保留。',
      ),
      !allowed,
    );
  }

  private async executeCommand(
    reader: Reader,
    batch: Batch | null,
    command: ReadingCommand,
    question: string,
  ): Promise<void> {
    if (['save', 'like', 'less'].includes(command.action)) {
      await this.commandAction(reader, batch, command.action as FeedbackAction, command.selection);
    } else if (command.action === 'preferences') {
      reader.interests = command.interests;
      this.store.saveReader(reader);
      await this.showPreferences(reader);
    } else if (command.action === 'saved') {
      await this.showSaved(reader, 0);
    } else if (command.action === 'recommend') {
      if (batch?.selected.length) await this.askToFinishSelection(reader);
      else await this.sendRecommendations(reader);
    } else if (command.action === 'explain') {
      const id =
        command.selection.length === 1 && batch
          ? batch.articleIds[(command.selection[0] ?? 0) - 1]
          : reader.focusedArticle;
      const article = id ? this.store.article(id) : null;
      if (!article) {
        await this.send(reader, readingMessage('请选中一篇文章，或回复清单告诉我文章编号。'));
        return;
      }
      reader.focusedArticle = article.id;
      const answer = await this.assistant.explain(
        question,
        reader,
        article,
        this.store.source(article.id),
      );
      command.reply = answer;
      await this.send(reader, readingMessage(escapeHtml(answer)));
    } else {
      await this.send(
        reader,
        readingMessage(escapeHtml(command.reply || '请告诉我你想读什么，或发送“推荐”。')),
      );
    }
  }

  private async handleButton(
    reader: Reader,
    batch: Batch,
    action: string,
    number: number | null,
  ): Promise<void> {
    if (!this.access.allowed(reader.userId) && ['preferences', 'explain'].includes(action)) return;
    if (action === 'select' && number !== null) {
      const id = batch.articleIds[number - 1];
      if (!id) return;
      batch.selected = batch.selected.includes(id)
        ? batch.selected.filter((selected) => selected !== id)
        : [...batch.selected, id];
      batch.notice = '';
      this.store.saveBatch(batch);
      await this.edit(reader, batch);
    } else if (action === 'clear') {
      batch.selected = [];
      this.store.saveBatch(batch);
      await this.edit(reader, batch);
    } else if (action === 'save' || action === 'like' || action === 'less' || action === 'unsave') {
      if (!batch.selected.length) return;
      this.applyFeedback(reader, batch, action);
      await this.edit(reader, batch);
    } else if (action === 'undo') {
      this.undoFeedback(reader, batch);
      await this.edit(reader, batch);
    } else if (action === 'more') {
      if (batch.selected.length) await this.askToFinishSelection(reader);
      else await this.sendRecommendations(reader);
    } else if (action === 'saved' || action === 'next' || action === 'prev') {
      if (batch.selected.length) await this.askToFinishSelection(reader);
      else
        await this.showSaved(
          reader,
          action === 'saved' ? 0 : Math.max(0, batch.page + (action === 'next' ? 1 : -1)),
          action === 'saved' ? undefined : batch,
        );
    } else if (action === 'preferences') {
      await this.showPreferences(reader);
    } else if (action === 'explain' && batch.selected.length === 1) {
      const id = batch.selected[0];
      let article = id ? this.store.article(id) : null;
      if (!article) return;
      reader.focusedArticle = article.id;
      reader.latestBatch = batch.id;
      this.store.saveReader(reader);
      if (this.deepReader && !article.summaryUrl) {
        await this.send(
          reader,
          readingMessage('正在整理这篇的完整摘要和 HN 讨论，通常需要几十秒。'),
        );
        if (!this.access.allowed(reader.userId)) return;
        article = await this.deepReader.prepare(article);
        if (!this.access.allowed(reader.userId)) return;
        await this.edit(reader, batch);
      }
      await this.send(
        reader,
        readingMessage(
          `<a href="${escapeHtml(article.summaryUrl ?? article.url)}">${escapeHtml(article.title)}</a>\n\n${escapeHtml(article.evidence !== 'title' ? article.description : '这篇目前只有标题与 HN 元数据，尚未取得正文。')}\n\n可以继续提问，我会结合已取得的正文回答。`,
        ),
      );
    }
  }

  private async commandAction(
    reader: Reader,
    batch: Batch | null,
    action: FeedbackAction,
    selection: number[],
  ): Promise<void> {
    if (
      !batch ||
      batch.userId !== reader.userId ||
      !selection.length ||
      selection.some((n) => !batch.articleIds[n - 1])
    ) {
      await this.send(
        reader,
        readingMessage('请回复对应的推荐清单，并注明编号，例如“收藏 2、4”。'),
      );
      return;
    }
    batch.selected = [
      ...new Set(
        selection
          .map((n) => batch.articleIds[n - 1])
          .filter((id): id is number => id !== undefined),
      ),
    ];
    this.applyFeedback(reader, batch, action);
    await this.edit(reader, batch);
  }

  private applyFeedback(reader: Reader, batch: Batch, action: FeedbackAction): void {
    const current = this.store.reader(reader.userId);
    if (current) reader.feedback = current.feedback;
    const undo: Batch['undo'] = [];
    for (const id of batch.selected) {
      const before = feedbackFor(reader, id);
      const after = { ...before };
      if (action === 'save') {
        after.saved = true;
        if (!before.saved) after.savedAt = this.now();
      }
      if (action === 'unsave') after.saved = false;
      if (action === 'like') after.opinion = 1;
      if (action === 'less') after.opinion = -1;
      if (before.saved === after.saved && before.opinion === after.opinion) continue;
      after.revision += 1;
      reader.feedback[id] = after;
      undo.push({ id, before, revision: after.revision });
    }
    if (undo.length) batch.undo = undo;
    const labels = {
      save: '已收藏',
      unsave: '已移出收藏',
      like: '已记录，会增加类似推荐',
      less: '已记录，会减少类似推荐',
    };
    batch.notice = undo.length
      ? `${labels[action]}（${undo.length} 篇）`
      : '这些文章已是所选状态。';
    batch.selected = [];
    this.store.transaction(() => {
      this.store.saveReader(reader);
      this.store.saveBatch(batch);
    });
  }

  private undoFeedback(reader: Reader, batch: Batch): void {
    const current = this.store.reader(reader.userId);
    if (current) reader.feedback = current.feedback;
    let restored = 0;
    for (const entry of batch.undo) {
      if (feedbackFor(reader, entry.id).revision !== entry.revision) continue;
      reader.feedback[entry.id] = { ...entry.before, revision: entry.revision + 1 };
      restored += 1;
    }
    batch.undo = [];
    batch.notice = restored
      ? `已撤销 ${restored} 篇的操作。`
      : '文章后来有过其他操作，未覆盖较新的状态。';
    this.store.transaction(() => {
      this.store.saveReader(reader);
      this.store.saveBatch(batch);
    });
  }

  private async sendRecommendations(reader: Reader): Promise<void> {
    const aiEnabled = this.access.allowed(reader.userId);
    if (!aiEnabled) {
      const limit = this.limits.checkRecommendation(reader.userId);
      if (!limit.allowed) {
        await this.send(
          reader,
          readingMessage(
            limit.reason === 'daily'
              ? '今天的 20 批推荐已用完，明天再来看看。收藏和阅读已有清单仍然可用。'
              : `请 ${limit.retryAfterSeconds} 秒后再获取一批推荐。收藏和阅读已有清单仍然可用。`,
          ),
          true,
        );
        return;
      }
    }
    if (
      aiEnabled ||
      this.lastPublicCatalogRefreshAt === null ||
      this.now() - this.lastPublicCatalogRefreshAt >= 30_000
    ) {
      if (!aiEnabled) this.lastPublicCatalogRefreshAt = this.now();
      await this.catalog.refresh(reader);
      this.lastPublicCatalogRefreshAt = this.now();
    }
    if (aiEnabled && !this.access.allowed(reader.userId)) return;
    const selected = recommend(reader, this.store.articles());
    if (!selected.length) {
      await this.send(
        reader,
        readingMessage('目前可用的文章已经推荐完了，稍后再来看看，或打开“我的收藏”。'),
        true,
      );
      return;
    }
    const batch = this.makeBatch(
      reader,
      selected.map((item) => item.article.id),
      'recommendations',
      0,
    );
    batch.reasons = Object.fromEntries(
      selected.map((item) => [String(item.article.id), item.reason]),
    );
    await this.deliverBatch(reader, batch);
    if (!aiEnabled) this.limits.recordRecommendation(reader.userId);
  }

  private async showSaved(reader: Reader, page: number, existing?: Batch): Promise<void> {
    const ids = Object.entries(reader.feedback)
      .filter(([, feedback]) => feedback.saved)
      .sort((a, b) => b[1].savedAt - a[1].savedAt || Number(b[0]) - Number(a[0]))
      .map(([id]) => Number(id));
    if (!ids.length) {
      await this.send(
        reader,
        readingMessage('还没有收藏。到频道文章下点击“收藏”，再发送 /saved 查看。'),
        true,
      );
      return;
    }
    const boundedPage = Math.min(page, Math.floor((ids.length - 1) / 5));
    const batch = this.makeBatch(
      reader,
      ids.slice(boundedPage * 5, boundedPage * 5 + 5),
      'saved',
      boundedPage,
    );
    if (existing) {
      batch.id = existing.id;
      batch.messageId = existing.messageId;
      this.store.saveBatch(batch);
      await this.edit(reader, batch);
    } else await this.deliverBatch(reader, batch);
  }

  private makeBatch(reader: Reader, ids: number[], kind: Batch['kind'], page: number): Batch {
    return {
      id: randomBytes(6).toString('hex'),
      userId: reader.userId,
      messageId: null,
      articleIds: ids,
      selected: [],
      reasons: {},
      kind,
      page,
      createdAt: this.now(),
      undo: [],
      notice: '',
    };
  }

  private async deliverBatch(reader: Reader, batch: Batch): Promise<void> {
    this.store.saveBatch(batch);
    batch.messageId = await this.send(
      reader,
      renderBatch(batch, reader, this.articlesFor(batch), true, this.access.allowed(reader.userId)),
      true,
    );
    reader.latestBatch = batch.id;
    if (batch.kind === 'recommendations')
      reader.seen = [...new Set([...reader.seen, ...batch.articleIds])].slice(-2000);
    this.store.transaction(() => {
      this.store.saveReader(reader);
      this.store.saveBatch(batch);
    });
    this.prepareBatch(batch);
  }

  private prepareBatch(batch: Batch): void {
    if (!this.access.allowed(batch.userId)) return;
    if (batch.kind === 'recommendations') {
      this.deepReader?.enqueue?.(this.articlesFor(batch), () =>
        this.serial(async () => {
          if (!this.access.allowed(batch.userId)) return;
          const currentReader = this.store.reader(batch.userId);
          const currentBatch = this.store.batch(batch.id);
          if (currentReader && currentBatch) await this.edit(currentReader, currentBatch);
        }),
      );
    }
  }

  private async showPreferences(reader: Reader): Promise<void> {
    const list = reader.interests
      .map((i) => `${i.weight < 0 ? '少推荐' : i.weight === 0 ? '中性' : '喜欢'}：${i.name}`)
      .join('\n');
    await this.send(
      reader,
      readingMessage(
        `<b>你的阅读偏好</b>\n${escapeHtml(list || '尚未设置')}\n\n直接告诉我想怎么改，例如“更偏数据库和工程复盘，少推荐融资新闻”。\n收藏是较弱的兴趣信号，“多推荐类似”影响更大。`,
      ),
    );
  }

  private async askToFinishSelection(reader: Reader): Promise<void> {
    await this.send(
      reader,
      readingMessage('当前清单还有选中的文章，请先执行操作或点“取消选择”。'),
      true,
    );
  }

  private articlesFor(batch: Batch): ReadingArticle[] {
    if (batch.kind === 'saved') this.channelFeedback?.refreshSavedArticles(batch.articleIds);
    return batch.articleIds.map((id) => {
      const article = this.store.article(id);
      if (!article) throw new Error('Reading article missing');
      return article;
    });
  }

  private async send(
    reader: Reader,
    message: ReadingMessage,
    publicAccess = false,
  ): Promise<number> {
    if (!publicAccess && !this.access.allowed(reader.userId))
      throw new Error('Reading access revoked');
    return sentSchema.parse(
      await this.transport.call('sendMessage', { chat_id: reader.userId, ...message }),
    ).message_id;
  }

  private async edit(reader: Reader, batch: Batch): Promise<void> {
    if (!batch.messageId) return;
    await this.transport.call('editMessageText', {
      chat_id: reader.userId,
      message_id: batch.messageId,
      ...renderBatch(
        batch,
        reader,
        this.articlesFor(batch),
        true,
        this.access.allowed(reader.userId),
      ),
    });
  }
}

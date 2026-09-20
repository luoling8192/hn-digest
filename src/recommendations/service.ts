import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { escapeHtml } from '../presentation.js';
import type { ReadingAssistant } from './assistant.js';
import {
  newReader,
  type Batch,
  type Reader,
  type ReadingArticle,
  type ReadingCommand,
} from './model.js';
import { readingMessage, renderBatch, type ReadingMessage } from './presentation.js';
import { feedbackFor, recommend } from './ranking.js';
import type { ReadingStore } from './store.js';
import type { DeepReader } from './deep-reading.js';

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

export class ReadingService {
  private operation: Promise<void> = Promise.resolve();
  constructor(
    readonly ownerId: number,
    private readonly store: ReadingStore,
    private readonly transport: ReadingTransport,
    private readonly catalog: Catalog,
    private readonly assistant: ReadingAssistant,
    private readonly now: () => number = Date.now,
    private readonly deepReader?: DeepReader,
  ) {}

  accepts(update: ReadingUpdate): boolean {
    const from = update.callback_query?.from ?? update.message?.from;
    const message = update.callback_query?.message ?? update.message;
    return (
      from?.id === this.ownerId &&
      !from.is_bot &&
      message?.chat.type === 'private' &&
      message.chat.id === from.id
    );
  }

  async handle(update: ReadingUpdate): Promise<void> {
    if (!this.accepts(update)) return;
    return this.serial(() => this.handleAuthorized(update));
  }

  async sendPreview(): Promise<void> {
    return this.serial(async () => {
      const reader = this.store.reader(this.ownerId) ?? newReader(this.ownerId);
      this.store.saveReader(reader);
      await this.sendRecommendations(reader);
    });
  }

  private serial(run: () => Promise<void>): Promise<void> {
    const operation = this.operation.then(run);
    this.operation = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }

  private async handleAuthorized(update: ReadingUpdate): Promise<void> {
    const reader = this.store.reader(this.ownerId) ?? newReader(this.ownerId);
    this.store.saveReader(reader);
    if (update.callback_query) {
      const callback = update.callback_query;
      await this.transport.call('answerCallbackQuery', { callback_query_id: callback.id });
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
    const repliedBatch = message.reply_to_message
      ? this.store.batchForMessage(reader.userId, message.reply_to_message.message_id)
      : null;
    const batch = message.reply_to_message
      ? repliedBatch
      : reader.latestBatch
        ? this.store.batch(reader.latestBatch)
        : null;
    if (/^\/start(?:\s.*)?$/.test(text)) {
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
    if (/^(\/recommend|推荐|再来(?:\s*5\s*篇)?|再来几篇|给我推荐)$/.test(text)) {
      if (batch?.selected.length) {
        await this.askToFinishSelection(reader);
        return;
      }
      await this.sendRecommendations(reader);
      return;
    }
    if (/^(\/saved|我的收藏|收藏夹)$/.test(text)) {
      await this.showSaved(reader, 0);
      return;
    }
    if (/^(\/preferences|我的偏好|调整方向)$/.test(text)) {
      await this.showPreferences(reader);
      return;
    }
    if (/^(\/help|帮助)$/.test(text)) {
      await this.send(
        reader,
        readingMessage(
          '发送“推荐”获取 5 篇；点编号后可批量收藏、反馈。\n发送“我的收藏”查看待读；发送“我的偏好”调整兴趣。\n回复清单说“收藏 2、4”或“聊聊第 2 篇”也可以。',
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
    const command = await this.assistant.understand(text, reader, articles);
    await this.executeCommand(reader, batch, command, text);
    reader.history = [
      ...reader.history,
      { role: 'user' as const, content: text },
      { role: 'assistant' as const, content: command.reply },
    ].slice(-6);
    this.store.saveReader(reader);
  }

  async reportFailure(): Promise<void> {
    await this.send(
      newReader(this.ownerId),
      readingMessage(
        '这次操作没有完整完成。可以重试按钮，或发送“推荐”重新获取；已经保存的收藏会保留。',
      ),
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
        article = await this.deepReader.prepare(article);
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
    await this.catalog.refresh(reader);
    const selected = recommend(reader, this.store.articles());
    if (!selected.length) {
      await this.send(
        reader,
        readingMessage('目前可用的文章已经推荐完了。可以调整兴趣寻找更多文章，或打开“我的收藏”。'),
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
  }

  private async showSaved(reader: Reader, page: number, existing?: Batch): Promise<void> {
    const ids = Object.entries(reader.feedback)
      .filter(([, feedback]) => feedback.saved)
      .sort((a, b) => b[1].savedAt - a[1].savedAt || Number(b[0]) - Number(a[0]))
      .map(([id]) => Number(id));
    if (!ids.length) {
      await this.send(reader, readingMessage('还没有收藏。先发送“推荐”，选中编号后点“收藏”。'));
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
    batch.messageId = await this.send(reader, renderBatch(batch, reader, this.articlesFor(batch)));
    reader.latestBatch = batch.id;
    if (batch.kind === 'recommendations')
      reader.seen = [...new Set([...reader.seen, ...batch.articleIds])].slice(-2000);
    this.store.transaction(() => {
      this.store.saveReader(reader);
      this.store.saveBatch(batch);
    });
    if (batch.kind === 'recommendations') {
      this.deepReader?.enqueue?.(this.articlesFor(batch), () =>
        this.serial(async () => {
          const currentReader = this.store.reader(reader.userId);
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
    await this.send(reader, readingMessage('当前清单还有选中的文章，请先执行操作或点“取消选择”。'));
  }

  private articlesFor(batch: Batch): ReadingArticle[] {
    return batch.articleIds.map((id) => {
      const article = this.store.article(id);
      if (!article) throw new Error('Reading article missing');
      return article;
    });
  }

  private async send(reader: Reader, message: ReadingMessage): Promise<number> {
    return sentSchema.parse(
      await this.transport.call('sendMessage', { chat_id: reader.userId, ...message }),
    ).message_id;
  }

  private async edit(reader: Reader, batch: Batch): Promise<void> {
    if (!batch.messageId) return;
    await this.transport.call('editMessageText', {
      chat_id: reader.userId,
      message_id: batch.messageId,
      ...renderBatch(batch, reader, this.articlesFor(batch)),
    });
  }
}

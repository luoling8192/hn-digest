import { z } from 'zod';
import { readingMessage, type ReadingButton, type ReadingMessage } from './presentation.js';
import type { ReadingStore } from './store.js';
import type { ReadingTransport, ReadingUpdate } from './service.js';

const grantsSchema = z.array(
  z.object({ userId: z.number().int().positive().safe(), enabled: z.boolean() }),
);

export class ReadingAccess {
  constructor(
    private readonly ownerId: number,
    private readonly store: ReadingStore,
    private readonly transport: ReadingTransport,
  ) {}

  grants() {
    return this.store.get('access:grants', grantsSchema) ?? [];
  }

  allowed(userId: number): boolean {
    return userId === this.ownerId || this.grants().some((g) => g.userId === userId && g.enabled);
  }

  private set(userId: number, enabled: boolean): void {
    if (userId === this.ownerId) return;
    const grants = this.grants().filter((g) => g.userId !== userId);
    grants.push({ userId, enabled });
    this.store.put('access:grants', grantsSchema.parse(grants));
  }

  panel(page = 0): ReadingMessage {
    const grants = this.grants().sort((a, b) => a.userId - b.userId);
    const bounded = Math.min(page, Math.max(0, Math.ceil(grants.length / 8) - 1));
    const selected = grants.slice(bounded * 8, bounded * 8 + 8);
    const text = [
      '<b>推荐用户管理</b>',
      `管理员：仅你本人 · 第 ${bounded + 1} 页`,
      '',
      ...selected.map((g) => `${g.userId} · ${g.enabled ? '已开启' : '已停用'}`),
      ...(grants.length ? [] : ['尚未添加其他用户。']),
      '',
      '添加后，请对方先私聊 Bot 发送 /start。对方可发送 /id 查看自己的 UID。',
      '开通仅授予文章推荐、收藏和偏好功能；管理面板仍仅你可用。各用户共用现有模型账户额度。',
    ].join('\n');
    const buttons: ReadingButton[][] = selected.map((g) => [
      {
        text: `${g.enabled ? '停用' : '开启'} ${g.userId}`,
        callback_data: `ops:${g.enabled ? 'revoke' : 'grant'}:${g.userId}`,
      },
    ]);
    buttons.push([{ text: '添加 UID', callback_data: 'ops:add' }]);
    const navigation: ReadingButton[] = [];
    if (bounded > 0) navigation.push({ text: '上一页', callback_data: `ops:users:${bounded - 1}` });
    if ((bounded + 1) * 8 < grants.length)
      navigation.push({ text: '下一页', callback_data: `ops:users:${bounded + 1}` });
    if (navigation.length) buttons.push(navigation);
    buttons.push([{ text: '返回运行状态', callback_data: 'ops:overview' }]);
    return readingMessage(text, buttons);
  }

  async handle(update: ReadingUpdate): Promise<boolean> {
    const from = update.callback_query?.from ?? update.message?.from;
    const text = update.message?.text?.trim() ?? '';
    const data = update.callback_query?.data ?? '';
    const command = /^(\/users|\/allow|\/deny|\/cancel)(?:\s|$)/.test(text);
    const action = /^ops:(?:users(?::\d+)?|add|cancel|(?:grant|revoke):\d+)$/.test(data);
    const awaiting =
      from?.id === this.ownerId && this.store.get('access:awaiting_uid', z.boolean()) === true;
    if (!command && !action && !(awaiting && /^\d+$/.test(text))) return false;
    if (from?.id !== this.ownerId) return true;
    const callback = update.callback_query;
    if (callback)
      await this.transport.call('answerCallbackQuery', { callback_query_id: callback.id });
    let panel: ReadingMessage;
    if (data === 'ops:add') {
      this.store.put('access:awaiting_uid', true);
      panel = readingMessage(
        '请发送对方的数字 Telegram UID，或使用 /allow UID 开通。\n对方可以先私聊 Bot 发送 /id 获取。',
        [[{ text: '取消', callback_data: 'ops:cancel' }]],
      );
    } else if (text === '/cancel' || data === 'ops:cancel') {
      this.store.put('access:awaiting_uid', false);
      panel = this.panel();
    } else {
      const mutation =
        text.match(/^\/(allow|deny)\s+(\d+)$/) ?? data.match(/^ops:(grant|revoke):(\d+)$/);
      const suppliedId = mutation?.[2] ?? (awaiting && /^\d+$/.test(text) ? text : null);
      if (suppliedId !== null) {
        const userId = Number(suppliedId);
        if (!Number.isSafeInteger(userId) || userId <= 0) {
          panel = readingMessage('UID 必须是有效的正整数，请重新输入。');
        } else {
          this.set(userId, mutation?.[1] !== 'deny' && mutation?.[1] !== 'revoke');
          this.store.put('access:awaiting_uid', false);
          panel = this.panel();
        }
      } else if (/^\/(allow|deny)(?:\s|$)/.test(text)) {
        panel = readingMessage('格式：/allow 数字UID 开通，/deny 数字UID 停用。');
      } else {
        panel = this.panel(Number(data.match(/^ops:users:(\d+)$/)?.[1] ?? 0));
      }
    }
    await this.transport.call(callback ? 'editMessageText' : 'sendMessage', {
      chat_id: this.ownerId,
      ...(callback?.message ? { message_id: callback.message.message_id } : {}),
      ...panel,
    });
    return true;
  }
}

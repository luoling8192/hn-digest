import type { DigestService } from '../application/digest-service.js';
import { escapeHtml } from '../presentation.js';
import type { ReadingBackfill } from './backfill.js';
import { type ReadingMessage, readingMessage } from './presentation.js';

export type StatusView = 'overview' | 'failures';

export function operationsPanel(
  service: DigestService,
  archive: ReadingBackfill | null,
  view: StatusView,
  now = Date.now(),
): ReadingMessage {
  const publications = service.publications();
  const failures = service.failures();
  const cycle = service.lastCycle();
  const published = publications.filter((p) => p.state === 'published');
  const recent = [...published].sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
  const lines = ['<b>HN Digest · 运行状态</b>', `更新于 ${time(now)}`, ''];
  if (view === 'failures') {
    lines.push(`<b>当前失败记录 · ${failures.length} 条</b>`);
    const ordered = [...failures].sort((a, b) => b.nextRetry - a.nextRetry);
    for (const failure of ordered.slice(0, 5)) {
      const title = publications.find((p) => p.id === failure.id)?.draft.summary.title;
      lines.push(
        `${failure.id}${title ? ` · ${escapeHtml(title.slice(0, 30))}` : ''}`,
        `<code>${escapeHtml(failure.code.slice(0, 60))}</code> · 尝试 ${failure.attempts} 次`,
        `重试最早时间：${time(failure.nextRetry)}`,
        '',
      );
    }
    if (!failures.length) lines.push('当前没有失败记录。');
    if (failures.length > 5) lines.push('仅显示重试时间最近的 5 条。');
    lines.push('这是当前记录，非累计失败数。未发布文章仍须在 HN Top 30 中才会自动重试。');
  } else {
    lines.push(
      '<b>频道推送</b>',
      `自动推送：${service.automaticPublishingEnabled() ? '已开启' : '已暂停'}`,
      `当前：${service.isRunning ? '处理中' : '空闲'}`,
    );
    const work = service.currentWork();
    if (work) lines.push(`${escapeHtml(work.stage)}${work.storyId ? ` · HN ${work.storyId}` : ''}`);
    if (cycle) {
      lines.push(
        `上一轮：${time(Date.parse(cycle.finishedAt))}`,
        `新发布 ${cycle.published} · 更新 ${cycle.updated} · 失败 ${cycle.failed}`,
      );
    } else lines.push('尚无完成的轮询记录。');
    lines.push(
      `已发布 ${published.length} · 待发布 ${publications.filter((p) => p.state === 'ready').length}`,
      `待核对投递 ${publications.filter((p) => p.state === 'uncertain' || p.state === 'sending').length} · 当前失败 ${failures.length}`,
      '',
      '<b>历史文章库</b>',
    );
    if (archive) {
      const inventory = archive.status();
      lines.push(
        `已索引 ${inventory.indexMonths}/60 个月 · ${inventory.indexed} 篇候选`,
        `历史解析 ${inventory.parsed}/${inventory.target} 篇 · 失败 ${inventory.failed}`,
        `可读文章 ${inventory.readable} · 深度摘要 ${inventory.deepPages}`,
        `阶段：${inventory.indexMonths < 60 ? '索引历史文章' : inventory.parsed < inventory.target ? '提取正文与生成介绍' : '目标已达成，等待补充'}`,
        `最近进展：${inventory.lastStep ? time(Date.parse(inventory.lastStep)) : '尚无记录'}`,
      );
    } else lines.push('历史文章库未启用。');
    lines.push('', '<b>最近发布</b>');
    for (const p of recent.slice(0, 3)) {
      lines.push(
        `${p.id} · ${escapeHtml(p.draft.summary.title.slice(0, 60))}`,
        p.publishedAt === null ? '发布时间未记录' : time(p.publishedAt),
      );
    }
    if (!recent.length) lines.push('尚无发布记录。');
  }
  return readingMessage(lines.join('\n'), [
    [
      { text: '刷新状态', callback_data: 'ops:overview' },
      { text: '查看失败', callback_data: 'ops:failures' },
    ],
    [{ text: 'AI 功能授权', callback_data: 'ops:users' }],
  ]);
}

function time(value: number): string {
  return `${new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Kuala_Lumpur',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(value)} (UTC+8)`;
}

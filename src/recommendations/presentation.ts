import { escapeHtml } from '../presentation.js';
import type { Batch, Reader, ReadingArticle } from './model.js';

export interface ReadingButton {
  text: string;
  callback_data: string;
}
export interface ReadingMessage {
  text: string;
  parse_mode: 'HTML';
  link_preview_options: { is_disabled: true };
  reply_markup: { inline_keyboard: ReadingButton[][] };
}

export function readingMessage(text: string, buttons: ReadingButton[][] = []): ReadingMessage {
  return {
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: buttons },
  };
}

export function renderBatch(
  batch: Batch,
  reader: Reader,
  articles: ReadingArticle[],
): ReadingMessage {
  const button = (text: string, action: string): ReadingButton => ({
    text,
    callback_data: `r:${batch.id}:${action}`,
  });
  const entries = batch.articleIds.map((id, index) => {
    const article = articles.find((candidate) => candidate.id === id);
    if (!article) throw new Error('Reading batch article missing');
    const saved = reader.feedback[id]?.saved ? ' ⭐' : '';
    const detail = [
      String(new Date(article.time * 1000).getUTCFullYear()),
      `${article.score} 分`,
      ...(article.minutes === null ? [] : [`约 ${article.minutes} 分钟`]),
    ].join(' · ');
    const description =
      article.evidence === 'title'
        ? '历史文章 · 仅标题译文，正文未提取'
        : article.description.slice(0, 100);
    return `${index + 1}. <a href="${escapeHtml(article.summaryUrl ?? article.url)}">${escapeHtml(article.title.slice(0, 90))}</a>${saved}\n${escapeHtml(description)}\n${detail}\n${escapeHtml(batch.reasons[id] ?? '')}`;
  });
  const title =
    batch.kind === 'saved'
      ? `⭐ 我的收藏 · 第 ${batch.page + 1} 页`
      : `为你挑了 ${entries.length} 篇`;
  const text = `<b>${title}</b>\n\n${entries.join('\n\n')}\n\n点标题阅读；点编号选择文章。${batch.notice ? `\n${escapeHtml(batch.notice)}` : ''}`;
  const rows: ReadingButton[][] = [
    batch.articleIds.map((id, index) =>
      button(`${batch.selected.includes(id) ? '✓ ' : ''}${index + 1}`, `select:${index + 1}`),
    ),
  ];
  if (batch.selected.length) {
    const n = batch.selected.length;
    rows.push([button(`收藏这 ${n} 篇`, 'save'), button('多推荐类似', 'like')]);
    rows.push([button('少推荐类似', 'less'), button('取消选择', 'clear')]);
    if (batch.kind === 'saved') rows.push([button('移出收藏', 'unsave')]);
    if (n === 1) rows.push([button('聊聊这篇', 'explain')]);
  } else if (batch.kind === 'saved') {
    rows.push([...(batch.page > 0 ? [button('上一页', 'prev')] : []), button('下一页', 'next')]);
    rows.push([button('给我推荐', 'more')]);
  } else {
    rows.push([button('再来 5 篇', 'more'), button('调整方向', 'preferences')]);
    rows.push([button('我的收藏', 'saved')]);
  }
  if (batch.undo.length) rows.push([button('撤销上次操作', 'undo')]);
  return readingMessage(text, rows);
}

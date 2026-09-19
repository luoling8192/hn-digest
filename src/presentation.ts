import { createHash } from 'node:crypto';
import type { Draft, TelegraphNode } from './domain.js';
import { isReusableTag, isScanCardSummary } from './domain.js';
import { hackerNewsUrl } from './adapters/hacker-news.js';

export interface TelegramMessagePayload {
  text: string;
  parse_mode: 'HTML';
  link_preview_options: {
    is_disabled: false;
    url: string;
    show_above_text: true;
  };
  reply_markup: {
    inline_keyboard: Array<Array<{ text: string; url: string }>>;
  };
}

function inlineNodes(text: string): TelegraphNode[] {
  return text
    .split(/(`[^`\n]+`)/g)
    .filter(Boolean)
    .map((part) =>
      part.startsWith('`') && part.endsWith('`')
        ? { tag: 'code', children: [part.slice(1, -1)] }
        : part,
    );
}

function paragraph(text: string): TelegraphNode {
  return { tag: 'p', children: inlineNodes(text) };
}

function heading(text: string): TelegraphNode {
  return { tag: 'h3', children: [text] };
}

function bulletList(items: string[]): TelegraphNode {
  return {
    tag: 'ul',
    children: items.map((item) => ({ tag: 'li', children: inlineNodes(item) })),
  };
}

function link(text: string, href: string): TelegraphNode {
  return { tag: 'a', attrs: { href }, children: [text] };
}

export function originalUrl(draft: Draft): string {
  const raw = draft.story.url;
  if (raw) {
    try {
      const url = new URL(raw);
      if (['https:', 'http:'].includes(url.protocol)) return url.href;
    } catch {
      // Invalid upstream URLs intentionally fall back to the HN discussion.
    }
  }
  return hackerNewsUrl(draft.story.id);
}

export function renderTelegraphPage(draft: Draft): TelegraphNode[] {
  const { story, summary } = draft;
  const nodes: TelegraphNode[] = [
    { tag: 'p', children: ['原标题：', link(story.title ?? summary.title, originalUrl(draft))] },
  ];

  if (isScanCardSummary(summary)) {
    nodes.push(
      heading('15 秒版'),
      paragraph(summary.quickTake),
      heading('看点'),
      bulletList(summary.whyItMatters),
    );
  }

  nodes.push(heading('原文摘要'), paragraph(summary.introduction));

  if (draft.article.source === 'unavailable') {
    nodes.push(
      paragraph(
        '原文正文暂时无法获取，以下讨论摘要仅基于已读取的 HN 评论，不代表对原文内容的核实。',
      ),
    );
  }

  for (const section of summary.article) {
    nodes.push(heading(section.heading), ...section.paragraphs.map(paragraph));
  }

  nodes.push({ tag: 'hr' }, heading('HN 讨论摘要'));
  if (summary.discussion.length === 0) nodes.push(paragraph('目前暂无足够的有效评论可供总结。'));
  for (const section of summary.discussion) {
    nodes.push({ tag: 'h4', children: [section.heading] }, paragraph(section.text));
    const references: TelegraphNode[] = ['相关评论：'];
    section.commentIds.forEach((id, index) => {
      if (index > 0) references.push(' · ');
      references.push(link(String(index + 1), hackerNewsUrl(id)));
    });
    nodes.push({ tag: 'p', children: references });
  }

  const generatedAt = new Date(draft.generatedAt).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  });
  nodes.push(
    paragraph(
      `基于 ${draft.comments.length}/${draft.commentCount} 条评论整理 · ${generatedAt}（北京时间） · AI 生成，请结合原文核对。`,
    ),
    { tag: 'hr' },
    { tag: 'p', children: ['原文：', link(originalUrl(draft), originalUrl(draft))] },
    { tag: 'p', children: ['评论：', link(hackerNewsUrl(story.id), hackerNewsUrl(story.id))] },
  );

  if (Buffer.byteLength(JSON.stringify(nodes)) > 64 * 1024) {
    throw new Error('Telegraph page exceeds 64 KB');
  }
  return nodes;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderTelegramMessage(draft: Draft, pageUrl: string): TelegramMessagePayload {
  const score = draft.story.score ?? 0;
  const readingTime =
    draft.article.readingMinutes === null ? '暂不可估算' : `${draft.article.readingMinutes} 分钟`;
  const title = `<a href="${escapeHtml(pageUrl)}">${escapeHtml(draft.summary.title)}</a>`;
  const details = `${readingTime} · ${score} 分${score >= 400 ? ' 🔥' : ''} · ${draft.story.descendants ?? 0} 评论`;
  const tagLine = isScanCardSummary(draft.summary)
    ? draft.summary.tags
        .filter(isReusableTag)
        .slice(0, 2)
        .map((tag) => `#${tag}`)
        .join(' ')
    : '';
  const tagHeader = tagLine ? `${tagLine}\n\n` : '';
  const text = isScanCardSummary(draft.summary)
    ? `${tagHeader}${title}\n\n${escapeHtml(draft.summary.quickTake)}\n\n${details}`
    : `${title}\n\n${details}`;

  if (text.length > 4_096) throw new Error('Telegram message exceeds 4096 characters');

  return {
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: false, url: pageUrl, show_above_text: true },
    reply_markup: {
      inline_keyboard: [
        [
          { text: '原文', url: originalUrl(draft) },
          { text: `评论：${draft.story.descendants ?? 0}`, url: hackerNewsUrl(draft.story.id) },
        ],
      ],
    },
  };
}

export function telegramMessageHash(draft: Draft, pageUrl: string): string {
  return createHash('sha256')
    .update(JSON.stringify(renderTelegramMessage(draft, pageUrl)))
    .digest('hex');
}

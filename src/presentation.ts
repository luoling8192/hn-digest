import { createHash } from 'node:crypto';
import { hackerNewsUrl } from './adapters/hacker-news.js';
import type { Draft, TelegraphNode } from './domain.js';
import { isReusableTag, isScanCardSummary } from './domain.js';
import type { FeedbackCounts } from './recommendations/store.js';

export interface TelegramMessagePayload {
  text: string;
  parse_mode: 'HTML';
  link_preview_options: {
    is_disabled: false;
    url: string;
    prefer_large_media: true;
    show_above_text: false;
  };
  reply_markup?: {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  };
}

export interface TelegramDelivery {
  kind: 'text';
  payload: TelegramMessagePayload;
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
  const rewrite = 'rewrite' in summary ? summary.rewrite : undefined;
  const originalTitle: TelegraphNode = {
    tag: 'p',
    children: ['原标题：', link(story.title ?? summary.title, originalUrl(draft))],
  };
  const nodes: TelegraphNode[] = rewrite ? [] : [originalTitle];
  const renderedImages = new Set<string>();
  const addImage = (url: string, caption: string) => {
    if (renderedImages.has(url) || !/^https?:\/\//i.test(url)) return;
    renderedImages.add(url);
    const children: TelegraphNode[] = [{ tag: 'img', attrs: { src: url } }];
    if (caption) children.push({ tag: 'figcaption', children: [caption] });
    nodes.push({ tag: 'figure', children });
  };
  if (rewrite && draft.article.media?.coverImage) {
    const coverImage = draft.article.media.coverImage;
    const cover = draft.article.media.images.find((image) => image.url === coverImage);
    addImage(coverImage, cover ? cover.caption : '');
  }

  if (!rewrite && isScanCardSummary(summary)) {
    nodes.push(paragraph(summary.quickTake));
  }

  if (draft.article.source === 'unavailable') {
    nodes.push(
      paragraph(
        rewrite
          ? '原文正文暂时无法获取，HN 讨论请见频道消息或文末讨论链接。'
          : '原文正文暂时无法获取，以下讨论摘要仅基于已读取的 HN 评论，不代表对原文内容的核实。',
      ),
    );
  }

  if (rewrite) {
    const media = new Map(draft.article.media?.images.map((image) => [image.id, image]));
    for (const section of rewrite.sections) {
      if (section.heading) nodes.push(heading(section.heading));
      nodes.push(...section.paragraphs.map(paragraph));
      for (const id of section.imageIds) {
        const image = media.get(id);
        if (image) addImage(image.url, image.caption);
      }
    }
  } else {
    nodes.push(heading('原文摘要'));
    if ('introduction' in summary) nodes.push(paragraph(summary.introduction));
    for (const section of summary.article) {
      if (section.heading) nodes.push(heading(section.heading));
      nodes.push(...section.paragraphs.map(paragraph));
    }

    nodes.push({ tag: 'hr' }, heading('HN 讨论综述'));
    if (summary.discussion.length === 0) nodes.push(paragraph('目前暂无足够的有效评论可供总结。'));
    const referenceNumbers = new Map<number, number>();
    for (const section of summary.discussion) {
      if ('heading' in section) nodes.push({ tag: 'h4', children: [section.heading] });
      const children = inlineNodes(section.text);
      for (const id of new Set(section.commentIds)) {
        const number = referenceNumbers.get(id) ?? referenceNumbers.size + 1;
        referenceNumbers.set(id, number);
        children.push(' ', link(`[${number}]`, hackerNewsUrl(id)));
      }
      nodes.push({ tag: 'p', children });
    }
  }

  const generatedAt = new Date(draft.generatedAt).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  nodes.push(
    { tag: 'hr' },
    {
      tag: 'p',
      children: [
        link('阅读原文', originalUrl(draft)),
        ' · ',
        link('HN 讨论', hackerNewsUrl(story.id)),
      ],
    },
    paragraph(
      `生成于 ${generatedAt}（北京时间）${rewrite ? '' : ` · 本次读取 ${draft.comments.length} 条评论`}`,
    ),
    {
      tag: 'p',
      children: [
        {
          tag: 'em',
          children: [
            rewrite
              ? '本文为 AI 生成的中文改写，请以原文为准。'
              : '本文由 AI 生成，请结合原文及评论核对。',
          ],
        },
      ],
    },
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

function shorten(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const prefix = text
    .slice(0, limit - 1)
    .replace(/[\uD800-\uDBFF]$/, '')
    .trimEnd();
  return `${prefix}…`;
}

function boundedParagraphs(paragraphs: string[], limit: number): string[] {
  const selected: string[] = [];
  let remaining = limit;
  for (const text of paragraphs) {
    if (remaining < 2) break;
    const value = shorten(text, remaining);
    selected.push(value);
    remaining -= value.length + 2;
    if (value !== text) break;
  }
  return selected;
}

function telegramSummary(draft: Draft): string {
  const article = boundedParagraphs(
    draft.summary.article.flatMap((section) => [
      ...(section.heading ? [section.heading] : []),
      ...section.paragraphs,
    ]),
    1_400,
  ).map(escapeHtml);
  const referenceNumbers = new Map<number, number>();
  const discussion: string[] = [];
  let remaining = 600;
  for (const section of draft.summary.discussion) {
    if (remaining < 2) break;
    const text = shorten(section.text, remaining);
    const citations = [...new Set(section.commentIds)].map((id) => {
      const number = referenceNumbers.get(id) ?? referenceNumbers.size + 1;
      referenceNumbers.set(id, number);
      return `<a href="${hackerNewsUrl(id)}">[${number}]</a>`;
    });
    discussion.push(`${escapeHtml(text)} ${citations.join(' ')}`);
    remaining -= text.length + 2;
    if (text !== section.text) break;
  }
  const articleText = article.length > 0 ? article.join('\n\n') : '原文正文暂时无法获取。';
  const discussionText =
    discussion.length > 0 ? discussion.join('\n\n') : '目前暂无足够的有效评论可供总结。';
  return `<blockquote expandable>${articleText}\n\n<b>HN 补充</b>\n${discussionText}</blockquote>`;
}

function telegramVisibleTextLength(text: string): number {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&').length;
}

export function channelFeedbackMarkup(
  storyId: number,
  counts: FeedbackCounts,
): NonNullable<TelegramMessagePayload['reply_markup']> {
  return {
    inline_keyboard: [
      [
        { text: `♡ 喜欢 ${counts.likes}`, callback_data: `d:like:${storyId}` },
        { text: `☆ 收藏 ${counts.saves}`, callback_data: `d:save:${storyId}` },
      ],
    ],
  };
}

export function renderTelegramMessage(
  draft: Draft,
  pageUrl: string,
  feedbackEnabled = false,
  counts: FeedbackCounts = { likes: 0, saves: 0 },
): TelegramMessagePayload {
  const score = draft.story.score ?? 0;
  const title = `<b><a href="${escapeHtml(originalUrl(draft))}">${escapeHtml(draft.summary.title)}</a></b> （★ ${score} 分${score >= 400 ? ' 🔥' : ''}）`;
  const tagLine = isScanCardSummary(draft.summary)
    ? draft.summary.tags
        .filter(isReusableTag)
        .slice(0, 2)
        .map((tag) => `#${tag}`)
        .join(' ')
    : '';
  const tagFooter = tagLine ? `\n\n${tagLine}` : '';
  const discussion = `<a href="${hackerNewsUrl(draft.story.id)}">💬 HN 讨论 · ${draft.story.descendants ?? 0} 条</a>`;
  const readingTime =
    draft.article.readingMinutes === null
      ? ''
      : `⏱️ 阅读时间：约 ${draft.article.readingMinutes} 分钟`;
  const metadata = readingTime ? `${readingTime}\n${discussion}` : discussion;
  const text = `${title}\n\n${telegramSummary(draft)}\n\n${metadata}${tagFooter}`;

  if (telegramVisibleTextLength(text) > 4_096)
    throw new Error('Telegram message exceeds 4096 characters');

  return {
    text,
    parse_mode: 'HTML',
    link_preview_options: {
      is_disabled: false,
      url: pageUrl,
      prefer_large_media: true,
      show_above_text: false,
    },
    ...(feedbackEnabled ? { reply_markup: channelFeedbackMarkup(draft.story.id, counts) } : {}),
  };
}

export function renderTelegramDelivery(
  draft: Draft,
  pageUrl: string,
  feedbackEnabled = false,
  counts: FeedbackCounts = { likes: 0, saves: 0 },
): TelegramDelivery {
  return {
    kind: 'text',
    payload: renderTelegramMessage(draft, pageUrl, feedbackEnabled, counts),
  };
}

export function telegramMessageHash(
  draft: Draft,
  pageUrl: string,
  feedbackEnabled = false,
): string {
  return createHash('sha256')
    .update(JSON.stringify(renderTelegramDelivery(draft, pageUrl, feedbackEnabled)))
    .digest('hex');
}

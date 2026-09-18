import { createHash } from 'node:crypto';
import { hnUrl } from './hn.js';
import type { Draft, TelegraphNode } from './types.js';

function inlineNodes(text: string): TelegraphNode[] {
  return text.split(/(`[^`\n]+`)/g).filter(Boolean).map(part => part.startsWith('`') && part.endsWith('`')
    ? { tag: 'code', children: [part.slice(1, -1)] } : part);
}
const paragraph = (text: string): TelegraphNode => ({ tag: 'p', children: inlineNodes(text) });
const heading = (text: string): TelegraphNode => ({ tag: 'h3', children: [text] });
const link = (text: string, href: string): TelegraphNode => ({ tag: 'a', attrs: { href }, children: [text] });
export function originalUrl(draft: Draft): string {
  const raw = draft.story.url;
  if (raw) {
    try { const u = new URL(raw); if (['https:', 'http:'].includes(u.protocol)) return u.href; } catch { /* Invalid upstream URL uses the HN post. */ }
  }
  return hnUrl(draft.story.id);
}
export function renderPage(draft: Draft): TelegraphNode[] {
  const { story, summary } = draft;
  const nodes: TelegraphNode[] = [
    { tag: 'p', children: ['原标题：', link(story.title ?? summary.title, originalUrl(draft))] },
    paragraph(summary.introduction),
  ];
  if (draft.article.source === 'unavailable') nodes.push(paragraph('原文正文暂时无法获取，以下讨论摘要仅基于已读取的 HN 评论，不代表对原文内容的核实。'));
  for (const section of summary.article) nodes.push(heading(section.heading), ...section.paragraphs.map(paragraph));
  nodes.push({ tag: 'hr' }, heading('HN 讨论摘要'));
  if (!summary.discussion.length) nodes.push(paragraph('目前暂无足够的有效评论可供总结。'));
  for (const section of summary.discussion) {
    nodes.push({ tag: 'h4', children: [section.heading] }, paragraph(section.text));
    const children: TelegraphNode[] = ['相关评论：'];
    section.commentIds.forEach((id, i) => { if (i) children.push(' · '); children.push(link(String(i + 1), hnUrl(id))); });
    nodes.push({ tag: 'p', children });
  }
  const time = new Date(draft.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  nodes.push(paragraph(`基于 ${draft.comments.length} 条有效评论整理，抓取时讨论串共 ${draft.commentCount} 条评论。采样可能不完整。更新于 ${time}（北京时间）。`),
    paragraph('文章与讨论摘要由 AI 生成，请结合原文和评论核对。'), { tag: 'hr' },
    { tag: 'p', children: ['原文：', link(originalUrl(draft), originalUrl(draft))] },
    { tag: 'p', children: ['评论：', link(hnUrl(story.id), hnUrl(story.id))] });
  if (Buffer.byteLength(JSON.stringify(nodes)) > 64 * 1024) throw new Error('Telegraph page exceeds 64 KB');
  return nodes;
}
export function escapeHtml(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
export function renderMessage(draft: Draft, pageUrl: string) {
  const score = draft.story.score ?? 0;
  const reading = draft.article.readingMinutes === null ? '暂不可估算' : `${draft.article.readingMinutes} 分钟`;
  return {
    text: `<a href="${escapeHtml(pageUrl)}">${escapeHtml(draft.summary.title)}</a>\n原文：${escapeHtml(originalUrl(draft))}\n阅读时间：${reading}\n分数：${score}${score >= 400 ? ' 🔥' : ''}`,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: false, url: pageUrl, show_above_text: true },
    reply_markup: { inline_keyboard: [[
      { text: '原文', url: originalUrl(draft) },
      { text: `评论：${draft.story.descendants ?? 0}`, url: hnUrl(draft.story.id) },
    ]] },
  };
}
export function messageHash(draft: Draft, pageUrl: string): string {
  return createHash('sha256').update(JSON.stringify(renderMessage(draft, pageUrl))).digest('hex');
}

import { z } from 'zod';

export const itemSchema = z.object({
  id: z.number().int(), type: z.string(), by: z.string().optional(),
  title: z.string().optional(), url: z.string().optional(), text: z.string().optional(),
  score: z.number().optional(), descendants: z.number().optional(),
  time: z.number(), kids: z.array(z.number().int()).default([]),
  parent: z.number().optional(), deleted: z.boolean().optional(), dead: z.boolean().optional(),
});
export type Item = z.infer<typeof itemSchema>;
export interface Comment { id: number; parent: number; author: string; text: string }
export interface Article { text: string; source: 'article' | 'hn-text' | 'unavailable'; readingMinutes: number | null }
const section = z.object({ heading: z.string().min(1).max(80), paragraphs: z.array(z.string().min(1).max(1500)).min(1).max(5) });
const baseSummarySchema = z.object({
  title: z.string().min(1).max(180),
  introduction: z.string().min(1).max(1000),
  article: z.array(section).max(6),
  discussion: z.array(z.object({
    heading: z.string().min(1).max(80),
    text: z.string().min(1).max(1500),
    commentIds: z.array(z.number().int()).min(1).max(5),
  })).max(6),
});
export const topicSchema = z.enum([
  'AI', '开发工具', '编程语言', '开源', '安全', '隐私', '数据库', 'Web',
  '云计算', '基础设施', '系统', '硬件', '科学', '创业', '产品', '其他',
]);
export const summarySchema = baseSummarySchema.extend({
  tags: z.array(topicSchema).min(2).max(4),
  quickTake: z.string().min(1).max(180),
  whyItMatters: z.array(z.string().min(1).max(120)).min(2).max(3),
  readIf: z.string().min(1).max(120),
  skipIf: z.string().min(1).max(120),
});
export type LegacySummary = z.infer<typeof baseSummarySchema>;
export type Summary = z.infer<typeof summarySchema>;
export interface Draft {
  story: Item; article: Article; comments: Comment[]; summary: LegacySummary | Summary;
  generatedAt: string; commentCount: number; commentHash: string;
}
export interface Page { path: string; url: string }
export interface Publication {
  id: number; state: 'ready' | 'sending' | 'published' | 'uncertain';
  draft: Draft; page: Page | null; messageId: number | null;
  messageHash: string | null; publishedAt: number | null; updatedAt: number; updates: number;
}
export type TelegraphNode = string | { tag: string; attrs?: Record<string, string>; children?: TelegraphNode[] };

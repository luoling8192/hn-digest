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
export const summarySchema = z.object({
  title: z.string().min(1).max(180),
  introduction: z.string().min(1).max(1000),
  article: z.array(section).max(6),
  discussion: z.array(z.object({
    heading: z.string().min(1).max(80),
    text: z.string().min(1).max(1500),
    commentIds: z.array(z.number().int()).min(1).max(5),
  })).max(6),
});
export type Summary = z.infer<typeof summarySchema>;
export interface Draft {
  story: Item; article: Article; comments: Comment[]; summary: Summary;
  generatedAt: string; commentCount: number; commentHash: string;
}
export interface Page { path: string; url: string }
export interface Publication {
  id: number; state: 'ready' | 'sending' | 'published' | 'uncertain';
  draft: Draft; page: Page | null; messageId: number | null;
  messageHash: string | null; publishedAt: number | null; updatedAt: number; updates: number;
}
export type TelegraphNode = string | { tag: string; attrs?: Record<string, string>; children?: TelegraphNode[] };

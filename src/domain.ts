import { z } from 'zod';

export const hackerNewsItemSchema = z.object({
  id: z.number().int().positive(),
  type: z.string(),
  by: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  text: z.string().optional(),
  score: z.number().int().nonnegative().optional(),
  descendants: z.number().int().nonnegative().optional(),
  time: z.number().int().nonnegative(),
  kids: z.array(z.number().int().positive()).default([]),
  parent: z.number().int().positive().optional(),
  deleted: z.boolean().optional(),
  dead: z.boolean().optional(),
});

export const commentSchema = z.object({
  id: z.number().int().positive(),
  parent: z.number().int().positive(),
  author: z.string().min(1),
  text: z.string().min(1),
});

export const articleSchema = z.object({
  text: z.string(),
  source: z.enum(['article', 'hn-text', 'unavailable']),
  readingMinutes: z.number().int().positive().nullable(),
});

const articleSectionSchema = z.object({
  heading: z.string().min(1).max(80),
  paragraphs: z.array(z.string().min(1).max(1_500)).min(1).max(5),
});

const discussionSectionSchema = z.object({
  heading: z.string().min(1).max(80),
  text: z.string().min(1).max(1_500),
  commentIds: z.array(z.number().int().positive()).min(1).max(5),
});

export const legacySummarySchema = z.object({
  title: z.string().min(1).max(180),
  introduction: z.string().min(1).max(1_000),
  article: z.array(articleSectionSchema).max(6),
  discussion: z.array(discussionSectionSchema).max(6),
});

const genericTags = new Set(['其他', '其它', '杂项', '综合', 'other', 'misc']);
const scanCardFields = {
  quickTake: z.string().min(1).max(180),
  whyItMatters: z.array(z.string().min(1).max(120)).min(2).max(3),
};

export const tagSchema = z
  .string()
  .min(1)
  .max(20)
  .regex(/^[A-Za-z0-9_\u3400-\u9FFF]+$/)
  .refine((tag) => !genericTags.has(tag.toLowerCase()), 'generic fallback tags are not allowed');

const persistedTagSchema = z.string().min(1).max(24);

export const summarySchema = legacySummarySchema.extend({
  tags: z.array(tagSchema).min(1).max(2),
  ...scanCardFields,
});

const persistedScanCardSummarySchema = legacySummarySchema.extend({
  tags: z.array(persistedTagSchema).min(1).max(4),
  ...scanCardFields,
  readIf: z.string().optional(),
  skipIf: z.string().optional(),
});

export const persistedSummarySchema = z.union([
  summarySchema,
  persistedScanCardSummarySchema,
  legacySummarySchema,
]);

export const draftSchema = z.object({
  story: hackerNewsItemSchema,
  article: articleSchema,
  comments: z.array(commentSchema),
  summary: persistedSummarySchema,
  generatedAt: z.iso.datetime(),
  commentCount: z.number().int().nonnegative(),
  commentHash: z.string().min(1),
});

export const pageSchema = z.object({
  path: z.string().min(1),
  url: z.url(),
});

export const deliveryStateSchema = z.enum(['ready', 'sending', 'published', 'uncertain']);

export const publicationSchema = z.object({
  id: z.number().int().positive(),
  state: deliveryStateSchema,
  draft: draftSchema,
  page: pageSchema.nullable(),
  messageId: z.number().int().positive().nullable(),
  messageHash: z.string().nullable(),
  publishedAt: z.number().int().nonnegative().nullable(),
  updatedAt: z.number().int().nonnegative(),
  updates: z.number().int().nonnegative(),
});

export const cycleResultSchema = z.object({
  finishedAt: z.iso.datetime(),
  published: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

export const failureRecordSchema = z.object({
  id: z.number().int().positive(),
  attempts: z.number().int().positive(),
  nextRetry: z.number().int().nonnegative(),
  code: z.string().min(1),
});

export type HackerNewsItem = z.infer<typeof hackerNewsItemSchema>;
export type Comment = z.infer<typeof commentSchema>;
export type Article = z.infer<typeof articleSchema>;
export type LegacySummary = z.infer<typeof legacySummarySchema>;
export type Summary = z.infer<typeof summarySchema>;
export type PersistedSummary = z.infer<typeof persistedSummarySchema>;
export type Draft = z.infer<typeof draftSchema>;
export type Page = z.infer<typeof pageSchema>;
export type DeliveryState = z.infer<typeof deliveryStateSchema>;
export type Publication = z.infer<typeof publicationSchema>;
export type CycleResult = z.infer<typeof cycleResultSchema>;
export type FailureRecord = z.infer<typeof failureRecordSchema>;
export interface TagFrequency {
  tag: string;
  uses: number;
}

export type TelegraphNode =
  | string
  | {
      tag: string;
      attrs?: Record<string, string>;
      children?: TelegraphNode[];
    };

export function isScanCardSummary(summary: PersistedSummary): summary is Summary {
  return persistedScanCardSummarySchema.safeParse(summary).success;
}

export function isReusableTag(tag: string): boolean {
  return tagSchema.safeParse(tag).success;
}

export function readyPublication(draft: Draft, now: number): Publication {
  return {
    id: draft.story.id,
    state: 'ready',
    draft,
    page: null,
    messageId: null,
    messageHash: null,
    publishedAt: null,
    updatedAt: now,
    updates: 0,
  };
}

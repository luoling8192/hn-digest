import { z } from 'zod';

export const interestSchema = z.object({
  name: z.string().trim().min(1).max(30),
  query: z.string().trim().min(1).max(80),
  weight: z.number().int().min(-3).max(3),
});
export const readingArticleSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1).max(180),
  originalTitle: z.string().max(300),
  url: z.url(),
  summaryUrl: z.url().nullable(),
  description: z.string().max(250),
  topics: z.array(z.string().min(1).max(30)).max(8),
  score: z.number().nonnegative(),
  time: z.number().nonnegative(),
  minutes: z.number().positive().nullable(),
  evidence: z.enum(['summary', 'fulltext', 'title']),
  sourceCharacters: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
});
export const candidateSchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  score: z.number().nonnegative(),
  comments: z.number().nonnegative(),
  time: z.number().nonnegative(),
  topics: z.array(z.string()),
  status: z.enum(['pending', 'ready', 'failed']),
  attemptedAt: z.number().nullable(),
});
export type Candidate = z.infer<typeof candidateSchema>;
export const feedbackSchema = z.object({
  saved: z.boolean(),
  opinion: z.number().int().min(-1).max(1),
  revision: z.number().int().nonnegative(),
  savedAt: z.number().nonnegative(),
});
export const readerSchema = z.object({
  userId: z.number().int().positive(),
  interests: z.array(interestSchema).max(8),
  feedback: z.record(z.string(), feedbackSchema),
  seen: z.array(z.number()).max(2000),
  latestBatch: z.string().nullable(),
  focusedArticle: z.number().nullable(),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).max(6),
});
export const batchSchema = z.object({
  id: z.string(),
  userId: z.number().int().positive(),
  messageId: z.number().int().positive().nullable(),
  articleIds: z.array(z.number()).max(5),
  selected: z.array(z.number()).max(5),
  reasons: z.record(z.string(), z.string()),
  kind: z.enum(['recommendations', 'saved']),
  page: z.number().int().nonnegative(),
  createdAt: z.number(),
  notice: z.string(),
  undo: z.array(z.object({ id: z.number(), before: feedbackSchema, revision: z.number() })).max(5),
});
export type Interest = z.infer<typeof interestSchema>;
export type ReadingArticle = z.infer<typeof readingArticleSchema>;
export type Feedback = z.infer<typeof feedbackSchema>;
export type Reader = z.infer<typeof readerSchema>;
export type Batch = z.infer<typeof batchSchema>;

export function newReader(userId: number): Reader {
  return {
    userId,
    interests: [
      { name: '架构', query: 'software architecture', weight: 3 },
      { name: '初创', query: 'startup lessons', weight: 3 },
      { name: '工程经验', query: 'engineering postmortem', weight: 3 },
    ],
    feedback: {},
    seen: [],
    latestBatch: null,
    focusedArticle: null,
    history: [],
  };
}

export function emptyFeedback(): Feedback {
  return { saved: false, opinion: 0, revision: 0, savedAt: 0 };
}

export const commandSchema = z.object({
  action: z.enum(['recommend', 'preferences', 'saved', 'save', 'like', 'less', 'explain', 'help']),
  selection: z.array(z.number().int().min(1).max(5)).max(5),
  interests: z.array(interestSchema).max(8),
  reply: z.string().max(1800),
});
export type ReadingCommand = z.infer<typeof commandSchema>;

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { type Article, articleSchema } from '../domain.js';
import {
  type Batch,
  batchSchema,
  type Candidate,
  candidateSchema,
  type Reader,
  type ReadingArticle,
  readerSchema,
  readingArticleSchema,
} from './model.js';

const rowSchema = z.object({ data: z.string() });
const identifierSchema = z.number().int().positive().safe();
const feedbackCountsSchema = z.object({
  likes: z.number().int().nonnegative(),
  saves: z.number().int().nonnegative(),
});
const feedbackSyncSchema = z.object({
  revision: identifierSchema,
  pending: z.boolean(),
});
const keyedRowSchema = rowSchema.extend({ key: z.string() });
const previewBindingSchema = z.object({ storyId: identifierSchema });
const previewKeySchema = z.string().regex(/^channel-preview:-?[1-9]\d*:[1-9]\d*$/);
const chatIdSchema = z.string().refine((value) => Number.isSafeInteger(Number(value)));

export type FeedbackCounts = z.infer<typeof feedbackCountsSchema>;

export class ReadingStore {
  private readonly db: DatabaseSync;
  private transactionDepth = 0;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'reading.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS reading_state (key TEXT PRIMARY KEY, data TEXT NOT NULL);`);
  }

  close(): void {
    this.db.close();
  }

  get<T>(key: string, schema: z.ZodType<T>): T | null {
    const row = this.db.prepare('SELECT data FROM reading_state WHERE key=?').get(key);
    return row ? schema.parse(JSON.parse(rowSchema.parse(row).data)) : null;
  }

  put(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO reading_state(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data',
      )
      .run(key, JSON.stringify(value));
  }

  reader(userId: number): Reader | null {
    return this.get(`reader:${userId}`, readerSchema);
  }
  saveReader(reader: Reader): void {
    this.transaction(() => {
      const current = this.reader(reader.userId);
      if (current) {
        for (const [id, feedback] of Object.entries(current.feedback)) {
          const proposed = reader.feedback[id];
          if (!proposed || proposed.revision < feedback.revision) {
            reader.feedback[id] = feedback;
          }
        }
      }
      const validated = readerSchema.parse(reader);
      this.put(`reader:${reader.userId}`, validated);
      for (const [id, feedback] of Object.entries(validated.feedback)) {
        const before = current?.feedback[id];
        if (
          feedback.saved !== (before?.saved === true) ||
          (feedback.opinion === 1) !== (before?.opinion === 1)
        ) {
          this.markFeedbackCounts(identifierSchema.parse(Number(id)));
        }
      }
    });
  }

  feedbackCounts(storyId: number): FeedbackCounts {
    identifierSchema.parse(storyId);
    const path = `$.feedback."${storyId}"`;
    return feedbackCountsSchema.parse(
      this.db
        .prepare(
          `SELECT
             COUNT(CASE WHEN json_extract(data, ?) = 1 THEN 1 END) AS likes,
             COUNT(CASE WHEN json_type(data, ?) = 'true' THEN 1 END) AS saves
           FROM reading_state WHERE key LIKE 'reader:%'`,
        )
        .get(`${path}.opinion`, `${path}.saved`),
    );
  }

  markFeedbackCounts(storyId: number): void {
    identifierSchema.parse(storyId);
    this.transaction(() => {
      const key = `feedback-count-sync:${storyId}`;
      const previous = this.get(key, feedbackSyncSchema);
      this.put(
        key,
        feedbackSyncSchema.parse({ revision: previous ? previous.revision + 1 : 1, pending: true }),
      );
    });
  }

  pendingFeedbackCounts(): Array<{ storyId: number; revision: number }> {
    return this.db
      .prepare(
        "SELECT key,data FROM reading_state WHERE key LIKE 'feedback-count-sync:%' ORDER BY key",
      )
      .all()
      .flatMap((raw) => {
        const row = keyedRowSchema.parse(raw);
        const state = feedbackSyncSchema.parse(JSON.parse(row.data));
        const storyId = identifierSchema.parse(
          Number(row.key.slice('feedback-count-sync:'.length)),
        );
        return state.pending ? [{ storyId, revision: state.revision }] : [];
      });
  }

  ackFeedbackCounts(storyId: number, revision: number): void {
    identifierSchema.parse(storyId);
    identifierSchema.parse(revision);
    this.transaction(() => {
      const key = `feedback-count-sync:${storyId}`;
      const current = this.get(key, feedbackSyncSchema);
      if (current?.revision === revision) this.put(key, { ...current, pending: false });
    });
  }

  channelPreviewBindings(): Array<{ chatId: string; messageId: number; storyId: number }> {
    return this.db
      .prepare("SELECT key,data FROM reading_state WHERE key LIKE 'channel-preview:%' ORDER BY key")
      .all()
      .map((raw) => {
        const row = keyedRowSchema.parse(raw);
        const key = previewKeySchema.parse(row.key);
        const [, chatId, messageId] = key.split(':');
        const binding = previewBindingSchema.parse(JSON.parse(row.data));
        return {
          chatId: chatIdSchema.parse(chatId),
          messageId: identifierSchema.parse(Number(messageId)),
          storyId: binding.storyId,
        };
      });
  }
  batch(id: string): Batch | null {
    return this.get(`batch:${id}`, batchSchema);
  }
  saveBatch(batch: Batch): void {
    this.put(`batch:${batch.id}`, batchSchema.parse(batch));
  }
  article(id: number): ReadingArticle | null {
    return this.get(`article:${id}`, readingArticleSchema);
  }
  saveArticle(article: ReadingArticle): void {
    this.put(`article:${article.id}`, readingArticleSchema.parse(article));
  }
  candidate(id: number): Candidate | null {
    return this.get(`candidate:${id}`, candidateSchema);
  }
  saveCandidate(candidate: Candidate): void {
    this.put(`candidate:${candidate.id}`, candidateSchema.parse(candidate));
  }
  source(id: number): Article | null {
    return this.get(`source:${id}`, articleSchema);
  }
  saveSource(id: number, source: Article): void {
    this.put(`source:${id}`, articleSchema.parse(source));
  }

  candidates(): Candidate[] {
    return this.db
      .prepare("SELECT data FROM reading_state WHERE key LIKE 'candidate:%'")
      .all()
      .map((row) => candidateSchema.parse(JSON.parse(rowSchema.parse(row).data)));
  }

  inventory() {
    const candidates = this.candidates();
    const articles = this.articles().filter((article) => article.evidence !== 'title');
    return {
      indexed: candidates.length,
      readable: articles.length,
      parsed: candidates.filter((candidate) => candidate.status === 'ready').length,
      truncated: articles.filter((article) => article.truncated).length,
      failed: candidates.filter((candidate) => candidate.status === 'failed').length,
      topics: Object.fromEntries(
        ['架构', '初创', '工程经验'].map((topic) => [
          topic,
          articles.filter((article) => article.topics.includes(topic)).length,
        ]),
      ),
      deepPages: articles.filter((article) => article.summaryUrl !== null).length,
    };
  }

  articles(): ReadingArticle[] {
    return this.db
      .prepare("SELECT data FROM reading_state WHERE key LIKE 'article:%'")
      .all()
      .map((row) => readingArticleSchema.parse(JSON.parse(rowSchema.parse(row).data)));
  }

  batchForMessage(userId: number, messageId: number): Batch | null {
    const row = this.db
      .prepare(
        "SELECT data FROM reading_state WHERE key LIKE 'batch:%' AND json_extract(data,'$.userId')=? AND json_extract(data,'$.messageId')=? LIMIT 1",
      )
      .get(userId, messageId);
    return row ? batchSchema.parse(JSON.parse(rowSchema.parse(row).data)) : null;
  }

  transaction(run: () => void): void {
    const nested = this.transactionDepth > 0;
    const savepoint = `reading_transaction_${this.transactionDepth}`;
    this.db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this.transactionDepth += 1;
    try {
      run();
      this.db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
    } catch (error) {
      if (nested) {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      } else this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  get offset(): number {
    return this.get('telegram:offset', z.number().int()) ?? 0;
  }
  set offset(value: number) {
    this.put('telegram:offset', value);
  }
}

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  batchSchema,
  candidateSchema,
  readerSchema,
  readingArticleSchema,
  type Batch,
  type Candidate,
  type Reader,
  type ReadingArticle,
} from './model.js';
import { articleSchema, type Article } from '../domain.js';

const rowSchema = z.object({ data: z.string() });

export class ReadingStore {
  private readonly db: DatabaseSync;

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
    this.put(`reader:${reader.userId}`, readerSchema.parse(reader));
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
    this.db.exec('BEGIN IMMEDIATE');
    try {
      run();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  get offset(): number {
    return this.get('telegram:offset', z.number().int()) ?? 0;
  }
  set offset(value: number) {
    this.put('telegram:offset', value);
  }
}

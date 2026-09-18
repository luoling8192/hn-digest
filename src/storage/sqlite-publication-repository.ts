import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { FailureRecord, Publication } from '../domain.js';
import { failureRecordSchema, publicationSchema } from '../domain.js';
import type { PublicationRepository } from './publication-repository.js';

const dataRowSchema = z.object({ data: z.union([z.string(), z.instanceof(Buffer)]) });
const settingRowSchema = z.object({ value: z.union([z.string(), z.instanceof(Buffer)]) });
const attemptsRowSchema = z.object({ attempts: z.number() });
const retryRowSchema = z.object({ next_retry: z.number() });
const ownerRowSchema = z.object({ owner: z.string() });
const failureRowSchema = z.object({
  id: z.number(),
  attempts: z.number(),
  next_retry: z.number(),
  code: z.string(),
});
const versionRowSchema = z.object({ user_version: z.number().int().nonnegative() });

export class SqlitePublicationRepository implements PublicationRepository {
  private readonly database: DatabaseSync;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(join(directory, 'digest.sqlite'));
    this.database.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS publications (
        id INTEGER PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS failures (
        id INTEGER PRIMARY KEY,
        attempts INTEGER NOT NULL,
        next_retry INTEGER NOT NULL,
        code TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS locks (
        key TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        expires INTEGER NOT NULL
      );
    `);
    const { user_version: version } = versionRowSchema.parse(
      this.database.prepare('PRAGMA user_version').get(),
    );
    if (version > 1) {
      this.database.close();
      throw new Error(`Unsupported database schema version ${version}`);
    }
    if (version === 0) this.database.exec('PRAGMA user_version=1');
  }

  close(): void {
    this.database.close();
  }

  getPublication(id: number): Publication | null {
    const raw = this.database.prepare('SELECT data FROM publications WHERE id = ?').get(id);
    const row = raw ? dataRowSchema.parse(raw) : null;
    return row ? parsePublication(row.data) : null;
  }

  listPublications(): Publication[] {
    const rows = z
      .array(dataRowSchema)
      .parse(this.database.prepare('SELECT data FROM publications ORDER BY id DESC').all());
    return rows.map((row) => parsePublication(row.data));
  }

  savePublication(publication: Publication): void {
    const validated = publicationSchema.parse(publication);
    this.database
      .prepare(
        'INSERT INTO publications(id, data) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
      )
      .run(validated.id, JSON.stringify(validated));
  }

  recordFailure(id: number, code: string, now: number): void {
    const raw = this.database.prepare('SELECT attempts FROM failures WHERE id = ?').get(id);
    const row = raw ? attemptsRowSchema.parse(raw) : null;
    const attempts = row ? Number(row.attempts) + 1 : 1;
    const delay = Math.min(6 * 3_600_000, 600_000 * 2 ** Math.min(attempts - 1, 6));
    this.database
      .prepare(
        `INSERT INTO failures(id, attempts, next_retry, code) VALUES(?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           attempts = excluded.attempts,
           next_retry = excluded.next_retry,
           code = excluded.code`,
      )
      .run(id, attempts, now + delay, code);
  }

  retryAllowed(id: number, now: number): boolean {
    const raw = this.database.prepare('SELECT next_retry FROM failures WHERE id = ?').get(id);
    const row = raw ? retryRowSchema.parse(raw) : null;
    return !row || Number(row.next_retry) <= now;
  }

  clearFailure(id: number): void {
    this.database.prepare('DELETE FROM failures WHERE id = ?').run(id);
  }

  listFailures(): FailureRecord[] {
    const rows = z
      .array(failureRowSchema)
      .parse(
        this.database
          .prepare('SELECT id, attempts, next_retry, code FROM failures ORDER BY next_retry DESC')
          .all(),
      );
    return rows.map((row) =>
      failureRecordSchema.parse({
        id: row.id,
        attempts: row.attempts,
        nextRetry: row.next_retry,
        code: row.code,
      }),
    );
  }

  getSetting(key: string): string | null {
    const raw = this.database.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    const row = raw ? settingRowSchema.parse(raw) : null;
    return row ? String(row.value) : null;
  }

  setSetting(key: string, value: string): void {
    this.database
      .prepare(
        'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  acquireLease(owner: string, now: number, durationMs: number): boolean {
    this.database
      .prepare(
        `INSERT INTO locks(key, owner, expires) VALUES('cycle', ?, ?)
         ON CONFLICT(key) DO UPDATE SET owner = excluded.owner, expires = excluded.expires
         WHERE locks.expires < ?`,
      )
      .run(owner, now + durationMs, now);
    const raw = this.database.prepare("SELECT owner FROM locks WHERE key = 'cycle'").get();
    const row = raw ? ownerRowSchema.parse(raw) : null;
    return row?.owner === owner;
  }

  renewLease(owner: string, now: number, durationMs: number): void {
    this.database
      .prepare("UPDATE locks SET expires = ? WHERE key = 'cycle' AND owner = ?")
      .run(now + durationMs, owner);
  }

  releaseLease(owner: string): void {
    this.database.prepare("DELETE FROM locks WHERE key = 'cycle' AND owner = ?").run(owner);
  }
}

function parsePublication(raw: unknown): Publication {
  let value: unknown;
  try {
    value = JSON.parse(String(raw));
  } catch (error) {
    throw new Error('Stored publication is not valid JSON', { cause: error });
  }
  return publicationSchema.parse(value);
}

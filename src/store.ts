import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Draft, Publication } from './types.js';

export class Store {
  readonly db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'digest.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS publications (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS failures (id INTEGER PRIMARY KEY, attempts INTEGER NOT NULL, next_retry INTEGER NOT NULL, code TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS locks (key TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);`);
  }
  close() { this.db.close(); }
  get(id: number): Publication | null {
    const row = this.db.prepare('SELECT data FROM publications WHERE id=?').get(id);
    return row ? JSON.parse(String(row.data)) as Publication : null;
  }
  all(): Publication[] { return this.db.prepare('SELECT data FROM publications ORDER BY id DESC').all().map(row => JSON.parse(String(row.data)) as Publication); }
  put(item: Publication) { this.db.prepare('INSERT INTO publications(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(item.id, JSON.stringify(item)); }
  prepare(draft: Draft): Publication {
    const item: Publication = { id: draft.story.id, state: 'ready', draft, page: null, messageId: null, messageHash: null, publishedAt: null, updatedAt: Date.now(), updates: 0 };
    this.put(item); return item;
  }
  fail(id: number, code: string) {
    const row = this.db.prepare('SELECT attempts FROM failures WHERE id=?').get(id);
    const attempts = row ? Number(row.attempts) + 1 : 1;
    this.db.prepare('INSERT INTO failures VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET attempts=excluded.attempts,next_retry=excluded.next_retry,code=excluded.code')
      .run(id, attempts, Date.now() + Math.min(6 * 3600_000, 600_000 * 2 ** Math.min(attempts - 1, 6)), code);
  }
  retryAllowed(id: number) { const row = this.db.prepare('SELECT next_retry FROM failures WHERE id=?').get(id); return !row || Number(row.next_retry) <= Date.now(); }
  clearFailure(id: number) { this.db.prepare('DELETE FROM failures WHERE id=?').run(id); }
  failures() { return this.db.prepare('SELECT id,attempts,next_retry,code FROM failures ORDER BY next_retry DESC').all(); }
  setting(key: string): string | null { const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? String(row.value) : null; }
  setSetting(key: string, value: string) { this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  acquire(owner: string) {
    this.db.prepare("INSERT INTO locks VALUES('cycle',?,?) ON CONFLICT(key) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE locks.expires < ?")
      .run(owner, Date.now() + 300_000, Date.now());
    return this.db.prepare("SELECT owner FROM locks WHERE key='cycle'").get()?.owner === owner;
  }
  renew(owner: string) { this.db.prepare("UPDATE locks SET expires=? WHERE key='cycle' AND owner=?").run(Date.now() + 300_000, owner); }
  release(owner: string) { this.db.prepare("DELETE FROM locks WHERE key='cycle' AND owner=?").run(owner); }
}

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { ReadingStore } from '../recommendations/store.js';

export const linkTtlMs = 10 * 60_000;
const codePrefix = 'reader-link:code:';
const tokenPrefix = 'reader-link:token:';

const codeSchema = z.object({
  secretHash: z.string(),
  expiresAt: z.number().int().nonnegative(),
  userId: z.number().int().positive().nullable(),
});
const tokenSchema = z.object({ userId: z.number().int().positive(), createdAt: z.number() });

export const codePattern = /^[A-Za-z0-9_-]{22}$/;
export const secretPattern = /^[A-Za-z0-9_-]{32,128}$/;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const equalHex = (a: string, b: string) => timingSafeEqual(Buffer.from(a), Buffer.from(b));

export type PollResult =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'linked'; token: string };

export class LinkStore {
  constructor(
    private readonly store: ReadingStore,
    private readonly now: () => number = Date.now,
  ) {}

  start(secret: string): { code: string; expiresAt: number } {
    const code = randomBytes(16).toString('base64url');
    const expiresAt = this.now() + linkTtlMs;
    this.store.transaction(() => {
      this.store.deleteExpired(codePrefix, this.now());
      this.store.put(`${codePrefix}${sha256(code)}`, {
        secretHash: sha256(secret),
        expiresAt,
        userId: null,
      });
    });
    return { code, expiresAt };
  }

  /** Binds an unclaimed, unexpired code to the Telegram user. A code binds at most once. */
  claim(code: string, userId: number): boolean {
    if (!codePattern.test(code)) return false;
    let claimed = false;
    this.store.transaction(() => {
      const key = `${codePrefix}${sha256(code)}`;
      const record = this.store.get(key, codeSchema);
      if (!record || record.userId !== null || record.expiresAt <= this.now()) return;
      this.store.put(key, { ...record, userId });
      claimed = true;
    });
    return claimed;
  }

  /** Returns the token once; the code record is deleted as it is issued. */
  poll(code: string, secret: string): PollResult {
    if (!codePattern.test(code) || !secretPattern.test(secret)) return { status: 'expired' };
    let result: PollResult = { status: 'expired' };
    this.store.transaction(() => {
      const key = `${codePrefix}${sha256(code)}`;
      const record = this.store.get(key, codeSchema);
      if (!record || !equalHex(record.secretHash, sha256(secret))) return;
      if (record.expiresAt <= this.now()) {
        this.store.delete(key);
        return;
      }
      if (record.userId === null) {
        result = { status: 'pending' };
        return;
      }
      const token = `shg_${randomBytes(32).toString('base64url')}`;
      this.store.put(`${tokenPrefix}${sha256(token)}`, {
        userId: record.userId,
        createdAt: this.now(),
      });
      this.store.delete(key);
      result = { status: 'linked', token };
    });
    return result;
  }

  authenticate(token: string): number | null {
    if (!/^shg_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return this.store.get(`${tokenPrefix}${sha256(token)}`, tokenSchema)?.userId ?? null;
  }

  revoke(token: string): boolean {
    if (this.authenticate(token) === null) return false;
    this.store.delete(`${tokenPrefix}${sha256(token)}`);
    return true;
  }
}

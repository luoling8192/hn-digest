import { z } from 'zod';
import type { ReadingStore } from './store.js';

const burst = 10;
const userTokenMs = 2000;
const globalTokenMs = 200;
const noticeMs = 30_000;
const recommendationCooldownMs = 30_000;
const dailyBatches = 20;
const dayMs = 24 * 60 * 60 * 1000;
const dayOffsetMs = 8 * 60 * 60 * 1000;
const globalKey = 'reading:limits:global';

const bucketSchema = z.object({
  remainingMs: z
    .number()
    .int()
    .min(0)
    .max(userTokenMs * burst),
  at: z.number().int().nonnegative(),
});
const userSchema = z.object({
  action: bucketSchema,
  lastNoticeAt: z.number().int().nonnegative().nullable(),
  recommendation: z.object({
    day: z.number().int().nonnegative(),
    count: z.number().int().nonnegative(),
    lastAt: z.number().int().nonnegative().nullable(),
  }),
});
type Bucket = z.infer<typeof bucketSchema>;
type UserLimits = z.infer<typeof userSchema>;

export type PublicActionAdmission =
  | { allowed: true }
  | {
      allowed: false;
      retryAfterSeconds: number;
      notify: boolean;
      reason: 'user' | 'global';
    };
export type RecommendationAdmission =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; reason: 'cooldown' | 'daily' };

function dayAt(now: number): number {
  return Math.floor((now + dayOffsetMs) / dayMs);
}

function fullBucket(now: number, tokenMs: number): Bucket {
  return { remainingMs: tokenMs * burst, at: now };
}

function refill(bucket: Bucket, now: number, tokenMs: number): Bucket {
  return {
    remainingMs: Math.min(tokenMs * burst, bucket.remainingMs + Math.max(0, now - bucket.at)),
    at: Math.max(now, bucket.at),
  };
}

function waitMs(bucket: Bucket, now: number, tokenMs: number): number {
  if (bucket.remainingMs >= tokenMs) return 0;
  return Math.max(0, bucket.at - now) + tokenMs - bucket.remainingMs;
}

export class ReadingLimits {
  constructor(
    private readonly store: Pick<ReadingStore, 'get' | 'put' | 'transaction'>,
    private readonly now: () => number = Date.now,
  ) {}

  admitPublicAction(userId: number): PublicActionAdmission {
    const now = this.time();
    let result: PublicActionAdmission = { allowed: true };
    this.store.transaction(() => {
      const state = this.user(userId, now);
      const userBucket = refill(state.action, now, userTokenMs);
      const globalBucket = refill(
        this.store.get(globalKey, bucketSchema) ?? fullBucket(now, globalTokenMs),
        now,
        globalTokenMs,
      );
      const userWait = waitMs(userBucket, now, userTokenMs);
      const globalWait = waitMs(globalBucket, now, globalTokenMs);
      if (userWait > 0 || globalWait > 0) {
        const notify = state.lastNoticeAt === null || now - state.lastNoticeAt >= noticeMs;
        if (notify) {
          state.lastNoticeAt = now;
          this.store.put(this.userKey(userId), state);
        }
        result = {
          allowed: false,
          reason: userWait > 0 ? 'user' : 'global',
          retryAfterSeconds: Math.ceil(Math.max(userWait, globalWait) / 1000),
          notify,
        };
        return;
      }
      userBucket.remainingMs -= userTokenMs;
      globalBucket.remainingMs -= globalTokenMs;
      state.action = userBucket;
      this.store.put(this.userKey(userId), state);
      this.store.put(globalKey, globalBucket);
    });
    return result;
  }

  checkRecommendation(userId: number): RecommendationAdmission {
    const now = this.time();
    const state = this.store.get(this.userKey(userId), userSchema);
    if (state === null) return { allowed: true };
    const recommendation = state.recommendation;
    if (dayAt(now) <= recommendation.day && recommendation.count >= dailyBatches) {
      return {
        allowed: false,
        reason: 'daily',
        retryAfterSeconds: Math.ceil(((recommendation.day + 1) * dayMs - dayOffsetMs - now) / 1000),
      };
    }
    if (recommendation.lastAt !== null && now < recommendation.lastAt + recommendationCooldownMs) {
      return {
        allowed: false,
        reason: 'cooldown',
        retryAfterSeconds: Math.ceil(
          (recommendation.lastAt + recommendationCooldownMs - now) / 1000,
        ),
      };
    }
    return { allowed: true };
  }

  recordRecommendation(userId: number): void {
    const now = this.time();
    this.store.transaction(() => {
      const state = this.user(userId, now);
      const day = Math.max(dayAt(now), state.recommendation.day);
      state.recommendation = {
        day,
        count: state.recommendation.day === day ? state.recommendation.count + 1 : 1,
        lastAt: Math.max(now, state.recommendation.lastAt ?? 0),
      };
      this.store.put(this.userKey(userId), state);
    });
  }

  private time(): number {
    return Math.max(0, Math.floor(this.now()));
  }

  private userKey(userId: number): string {
    return `reading:limits:user:${userId}`;
  }

  private user(userId: number, now: number): UserLimits {
    return (
      this.store.get(this.userKey(userId), userSchema) ?? {
        action: fullBucket(now, userTokenMs),
        lastNoticeAt: null,
        recommendation: { day: dayAt(now), count: 0, lastAt: null },
      }
    );
  }
}

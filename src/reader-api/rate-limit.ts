// In-memory per-client token buckets. The service runs as a single replica, so
// process-local state is sufficient and is reset on restart by design.
export interface IpLimit {
  burst: number;
  refillPerMinute: number;
}

export type IpAdmission = { allowed: true } | { allowed: false; retryAfterSeconds: number };

const maxTrackedClients = 10_000;

export class IpRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly limit: IpLimit,
    private readonly now: () => number = Date.now,
  ) {}

  admit(client: string): IpAdmission {
    const now = this.now();
    const tokenMs = 60_000 / this.limit.refillPerMinute;
    const previous = this.buckets.get(client);
    const tokens = Math.min(
      this.limit.burst,
      (previous?.tokens ?? this.limit.burst) + Math.max(0, now - (previous?.at ?? now)) / tokenMs,
    );
    if (tokens < 1) {
      this.buckets.set(client, { tokens, at: now });
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(((1 - tokens) * tokenMs) / 1000)),
      };
    }
    this.buckets.delete(client);
    this.buckets.set(client, { tokens: tokens - 1, at: now });
    if (this.buckets.size > maxTrackedClients) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
    return { allowed: true };
  }
}

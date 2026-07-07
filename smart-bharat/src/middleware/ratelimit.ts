import type { Request, Response, NextFunction } from "express";

/**
 * Token-bucket rate limiting (spec §7). In-memory here; the bucket interface is
 * intentionally minimal so it swaps to Redis (INCR/EXPIRE or a Lua token bucket)
 * without touching call sites. Cheap agents (query) get generous budgets;
 * expensive ones (automation, voice) get tight ones.
 */

interface Bucket {
  tokens: number;
  last: number;
  capacity: number;
}
const buckets = new Map<string, Bucket>();

export interface LimitOpts {
  name: string; // bucket namespace, e.g. "chat", "automation"
  capacity: number; // max burst
  refillPerSec: number; // sustained rate
  keyBy?: (req: Request) => string; // default: authenticated userId, else IP
}

// Periodic eviction so the bucket map can't grow unbounded (one entry per distinct
// user/IP × namespace otherwise leaks forever). A bucket that has fully refilled and
// been idle a while is indistinguishable from a fresh one, so dropping it is free.
const IDLE_MS = 10 * 60 * 1000;
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) {
    if (b.tokens >= b.capacity && now - b.last > IDLE_MS) buckets.delete(key);
  }
}, IDLE_MS);
sweep.unref?.(); // don't keep the process alive just for the sweeper

/** Returns remaining wait in seconds if throttled, or 0 if the token was granted. */
function take(key: string, capacity: number, refillPerSec: number): number {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: capacity, last: now, capacity };
    buckets.set(key, b);
  }
  const elapsed = (now - b.last) / 1000;
  b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerSec);
  b.last = now;
  if (b.tokens < 1) return Math.max(1, Math.ceil((1 - b.tokens) / refillPerSec));
  b.tokens -= 1;
  return 0;
}

const defaultKey = (req: Request) => (req as any).userId || req.ip || "anon";

export function rateLimit(opts: LimitOpts) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${opts.name}:${(opts.keyBy ?? defaultKey)(req)}`;
    const retryAfter = take(key, opts.capacity, opts.refillPerSec);
    if (retryAfter > 0) {
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ error: "rate_limited", bucket: opts.name, retry_after_s: retryAfter });
    }
    next();
  };
}

/** IP-scoped limiter for auth endpoints (blunt credential-stuffing). */
export const ipLimit = (capacity: number, refillPerSec: number) =>
  rateLimit({ name: "auth-ip", capacity, refillPerSec, keyBy: (req) => req.ip || "anon" });

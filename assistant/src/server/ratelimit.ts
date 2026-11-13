/**
 * Rate limits: a fixed window per key.
 *
 * Two keys are used. A signed-in person is limited by their address, so one
 * account cannot run the language model without end; a caller with no session
 * is limited by network address, so the unauthenticated paths (`/switches`,
 * `/open/…`, the sign-in pass-through) cannot be hammered either. Counters live
 * in this process: with several replicas each keeps its own, which loosens the
 * limit by the replica count and never tightens it.
 */
export interface Limit {
  /** Requests allowed in one window. 0 turns the limit off. */
  max: number;
  windowSeconds: number;
}

export type Decision = { ok: true } | { ok: false; retryAfterSeconds: number };

export class RateLimiter {
  private readonly windows = new Map<string, { resetAt: number; count: number }>();

  constructor(private readonly clock: () => number = Date.now) {}

  check(key: string, limit: Limit): Decision {
    if (limit.max <= 0) return { ok: true };
    const now = this.clock();
    const current = this.windows.get(key);
    if (!current || current.resetAt <= now) {
      this.windows.set(key, { resetAt: now + limit.windowSeconds * 1000, count: 1 });
      if (this.windows.size > 20_000) this.sweep(now);
      return { ok: true };
    }
    if (current.count >= limit.max) {
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
    }
    current.count += 1;
    return { ok: true };
  }

  private sweep(now: number): void {
    for (const [key, value] of this.windows) if (value.resetAt <= now) this.windows.delete(key);
  }
}

/** The caller's address as the proxy in front of the assistant reports it. */
export function clientAddress(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "unknown";
}

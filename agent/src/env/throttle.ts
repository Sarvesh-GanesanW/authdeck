/**
 * A token bucket like rateLimit.ts's RateLimiter (same refill rule), that can also say when the
 * next call will be allowed, so a refused command can tell the person how long to wait.
 */
import type { RateLimit } from '../rateLimit';

export class Throttle {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly limit: RateLimit,
    private readonly now: () => number,
  ) {
    this.tokens = limit.burst;
    this.updatedAt = now();
  }

  /** Spends one call; false when over the limit. */
  tryTake(): boolean {
    this.refill();
    if (this.tokens === 0) return false;
    this.tokens -= 1;
    return true;
  }

  /** Milliseconds until tryTake would succeed; 0 when it would now. */
  retryAfterMs(): number {
    this.refill();
    if (this.tokens > 0) return 0;
    return Math.max(0, this.updatedAt + this.limit.refillMs - this.now());
  }

  private refill(): void {
    const now = this.now();
    const refilled = Math.floor((now - this.updatedAt) / this.limit.refillMs);
    if (refilled > 0) {
      this.tokens = Math.min(this.limit.burst, this.tokens + refilled);
      this.updatedAt += refilled * this.limit.refillMs;
    }
    if (this.tokens === this.limit.burst) this.updatedAt = now;
  }
}

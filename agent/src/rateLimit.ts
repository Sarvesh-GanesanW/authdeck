/** How many calls a connection may make in a burst, and how fast that allowance comes back. */
export interface RateLimit {
  burst: number;
  /** One more call is allowed after each interval. */
  refillMs: number;
}

/** Token bucket for one connection and one kind of call. The clock is passed in so tests can move it. */
export class RateLimiter {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly limit: RateLimit,
    private readonly now: () => number,
  ) {
    this.tokens = limit.burst;
    this.updatedAt = now();
  }

  /** Spends one call; false when the connection is over its limit. */
  tryTake(): boolean {
    const now = this.now();
    const refilled = Math.floor((now - this.updatedAt) / this.limit.refillMs);
    if (refilled > 0) {
      this.tokens = Math.min(this.limit.burst, this.tokens + refilled);
      this.updatedAt += refilled * this.limit.refillMs;
    }
    if (this.tokens === this.limit.burst) this.updatedAt = now;
    if (this.tokens === 0) return false;
    this.tokens -= 1;
    return true;
  }
}

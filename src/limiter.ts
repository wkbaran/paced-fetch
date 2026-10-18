/**
 * Pacing for one API host: at most `concurrency` requests in flight, at most
 * `rate.count` started in any `rate.perMs` window, and at least `minGapMs`
 * between starts. A 429 can widen the gap for the rest of the process.
 */

export interface Rate {
  count: number;
  perMs: number;
}

export interface LimiterOptions {
  rate?: Rate;
  concurrency?: number;
  minGapMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class Limiter {
  private starts: number[] = [];
  private lastStart = -Infinity;
  private active = 0;
  private waiting: (() => void)[] = [];
  /** Extra gap learned from 429s. */
  private penaltyMs = 0;
  private okSincePenalty = 0;
  /** Requests fail at once until then (a Retry-After too long to wait out). */
  blockedUntil = 0;
  /** The start of the 429 body that set the block. */
  blockedDetail = "";

  constructor(private readonly opts: LimiterOptions) {}

  private get now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Waits for a slot; call the returned function when the request is done. */
  async acquire(): Promise<() => void> {
    const limit = this.opts.concurrency ?? Infinity;
    if (this.active >= limit) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      await this.waitForStart();
    } catch (err) {
      this.release();
      throw err;
    }
    return () => this.release();
  }

  private release(): void {
    this.active--;
    this.waiting.shift()?.();
  }

  private async waitForStart(): Promise<void> {
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    // A finished sleep counts as the time it was for, even if the clock disagrees
    // (an injected sleep in tests), so the loop always ends.
    let slept = -Infinity;
    for (;;) {
      const now = Math.max(this.now, slept);
      const rate = this.opts.rate;
      if (rate) this.starts = this.starts.filter((t) => now - t < rate.perMs);
      const gap = (this.opts.minGapMs ?? 0) + this.penaltyMs;
      let wait = Math.max(0, this.lastStart + gap - now);
      if (rate && this.starts.length >= rate.count) wait = Math.max(wait, this.starts[0]! + rate.perMs - now);
      if (wait <= 0) {
        this.lastStart = now;
        if (rate) this.starts.push(now);
        return;
      }
      await sleep(wait);
      slept = now + wait;
    }
  }

  /** After a 429: space later requests further apart (doubling, up to `maxMs`). */
  slowDown(maxMs = 10_000): void {
    this.penaltyMs = Math.min(maxMs, Math.max(250, this.penaltyMs * 2));
    this.okSincePenalty = 0;
  }

  /** After a success: every 20 in a row halve the extra gap, so a long-lived server recovers. */
  succeeded(): void {
    if (!this.penaltyMs || ++this.okSincePenalty < 20) return;
    this.okSincePenalty = 0;
    this.penaltyMs = this.penaltyMs >= 500 ? this.penaltyMs / 2 : 0;
  }

  get extraGapMs(): number {
    return this.penaltyMs;
  }
}

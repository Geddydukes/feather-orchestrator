
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; last: number }>();
  constructor(private rps: Record<string, { rps: number; burst?: number }>) {}
  async take(key: string): Promise<void> {
    const conf = this.rps[key];
    if (!conf) return;
    const now = Date.now();
    const init = this.buckets.get(key) ?? { tokens: conf.burst ?? conf.rps, last: now };
    const elapsed = (now - init.last) / 1000;
    init.tokens = Math.min(conf.burst ?? conf.rps, init.tokens + elapsed * conf.rps);
    if (init.tokens < 1) {
      const waitMs = ((1 - init.tokens) / conf.rps) * 1000;
      await new Promise(r => setTimeout(r, waitMs));
      return this.take(key);
    }
    init.tokens -= 1;
    init.last = now;
    this.buckets.set(key, init);
  }
}

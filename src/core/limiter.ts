import { createAbortError } from "./abort.js";

export class RateLimiter {
  private buckets = new Map<string, { tokens: number; last: number }>();
  private queues = new Map<string, Array<{ resolve: () => void; signal?: AbortSignal }>>();

  constructor(private rps: Record<string, { rps: number; burst?: number }>) {}

  tryTake(key: string): boolean {
    const conf = this.rps[key];
    if (!conf) return true; // unlimited
    
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: conf.burst ?? conf.rps, last: now };
    const elapsed = (now - b.last) / 1000;
    b.tokens = Math.min(conf.burst ?? conf.rps, b.tokens + elapsed * conf.rps);
    
    if (b.tokens >= 1) {
      b.tokens -= 1;
      b.last = now;
      this.buckets.set(key, b);
      return true;
    }
    
    this.buckets.set(key, b);
    return false;
  }

  async take(key: string, opts?: { signal?: AbortSignal }): Promise<void> {
    if (this.tryTake(key)) return;
    
    const q = this.queues.get(key) ?? [];
    this.queues.set(key, q);
    
    await new Promise<void>((resolve, reject) => {
      const entry = { resolve, signal: opts?.signal };
      q.push(entry);
      
      const onAbort = () => {
        const idx = q.indexOf(entry);
        if (idx >= 0) q.splice(idx, 1);
        reject(createAbortError(opts?.signal?.reason));
      };
      
      if (opts?.signal?.aborted) {
        onAbort();
      } else {
        opts?.signal?.addEventListener("abort", onAbort, { once: true });
      }
      
      this.pump(key);
    });
  }

  private pump(key: string): void {
    const conf = this.rps[key];
    if (!conf) return;
    
    const q = this.queues.get(key);
    if (!q?.length) return;

    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: conf.burst ?? conf.rps, last: now };
    const elapsed = (now - b.last) / 1000;
    b.tokens = Math.min(conf.burst ?? conf.rps, b.tokens + elapsed * conf.rps);

    while (b.tokens >= 1 && q.length) {
      const waiter = q.shift()!;
      b.tokens -= 1;
      waiter.resolve();
    }
    
    b.last = now;
    this.buckets.set(key, b);

    if (q.length) {
      const need = 1 - b.tokens;
      const waitMs = Math.max(0, (need / conf.rps) * 1000);
      setTimeout(() => this.pump(key), waitMs);
    }
  }
}

import type { RedisClientLike, RedisMultiLike } from "../../src/memory/redis.js";
import type { RedisRateLimiterClient } from "../../src/agent/quotas-redis.js";

interface ScriptOptions {
  keys: string[];
  arguments: string[];
}

class MockRedisMulti implements RedisMultiLike {
  private readonly operations: Array<() => Promise<unknown>> = [];

  constructor(private readonly client: MockRedisClient) {}

  rPush(key: string, value: string): MockRedisMulti {
    this.operations.push(() => this.client.rPush(key, value));
    return this;
  }

  lTrim(key: string, start: number, stop: number): MockRedisMulti {
    this.operations.push(() => this.client.lTrim(key, start, stop));
    return this;
  }

  expire(key: string, ttlSeconds: number): MockRedisMulti {
    this.operations.push(() => this.client.expire(key, ttlSeconds));
    return this;
  }

  del(key: string): MockRedisMulti {
    this.operations.push(() => this.client.del(key));
    return this;
  }

  async exec(): Promise<unknown> {
    const results: unknown[] = [];
    for (const operation of this.operations) {
      results.push(await operation());
    }
    return results;
  }
}

export class MockRedisClient implements RedisClientLike, RedisRateLimiterClient {
  private readonly lists = new Map<string, string[]>();
  private readonly counters = new Map<string, number>();
  private readonly expirations = new Map<string, number>();
  private readonly scripts = new Map<string, string>();
  private now = 0;
  private scriptCounter = 0;

  async rPush(key: string, value: string): Promise<number> {
    this.ensureFresh(key);
    const list = this.lists.get(key) ?? [];
    list.push(value);
    this.lists.set(key, list);
    return list.length;
  }

  async lRange(key: string, start: number, stop: number): Promise<string[]> {
    this.ensureFresh(key);
    const list = this.lists.get(key) ?? [];
    if (list.length === 0) {
      return [];
    }
    const { startIndex, stopIndex } = this.resolveRange(list.length, start, stop);
    if (startIndex > stopIndex) {
      return [];
    }
    return list.slice(startIndex, stopIndex + 1);
  }

  async lTrim(key: string, start: number, stop: number): Promise<unknown> {
    this.ensureFresh(key);
    const list = this.lists.get(key) ?? [];
    if (list.length === 0) {
      return null;
    }
    const { startIndex, stopIndex } = this.resolveRange(list.length, start, stop);
    if (startIndex > stopIndex) {
      this.lists.set(key, []);
      return null;
    }
    this.lists.set(key, list.slice(startIndex, stopIndex + 1));
    return null;
  }

  async lLen(key: string): Promise<number> {
    this.ensureFresh(key);
    return this.lists.get(key)?.length ?? 0;
  }

  async expire(key: string, ttlSeconds: number): Promise<number> {
    this.setExpiry(key, ttlSeconds * 1000);
    return 1;
  }

  async del(key: string): Promise<number> {
    this.lists.delete(key);
    this.counters.delete(key);
    this.expirations.delete(key);
    return 1;
  }

  multi(): MockRedisMulti {
    return new MockRedisMulti(this);
  }

  async eval(script: string, options: ScriptOptions): Promise<unknown> {
    return this.executeScript(script, options);
  }

  async evalSha(sha: string, options: ScriptOptions): Promise<unknown> {
    const script = this.scripts.get(sha);
    if (!script) {
      const error = new Error("NOSCRIPT");
      throw error;
    }
    return this.executeScript(script, options);
  }

  async scriptLoad(script: string): Promise<string> {
    this.scriptCounter += 1;
    const sha = `sha:${this.scriptCounter}`;
    this.scripts.set(sha, script);
    return sha;
  }

  async incr(key: string): Promise<number> {
    this.ensureFresh(key);
    const current = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, current);
    return current;
  }

  async pExpire(key: string, ttlMs: number): Promise<number> {
    this.setExpiry(key, ttlMs);
    return 1;
  }

  advanceTime(ms: number): void {
    if (ms < 0) {
      throw new Error("Cannot rewind time in mock redis");
    }
    this.now += ms;
    this.evictExpired();
  }

  getList(key: string): string[] {
    this.ensureFresh(key);
    return [...(this.lists.get(key) ?? [])];
  }

  getCounter(key: string): number {
    this.ensureFresh(key);
    return this.counters.get(key) ?? 0;
  }

  getExpiry(key: string): number | undefined {
    const expiry = this.expirations.get(key);
    if (expiry === undefined) {
      return undefined;
    }
    return Math.max(0, expiry - this.now);
  }

  private executeScript(script: string, options: ScriptOptions): Promise<unknown> {
    if (script.includes("RPUSH") && script.includes("LTRIM")) {
      return this.runAppendScript(options);
    }
    if (script.includes("INCR") && script.includes("PEXPIRE")) {
      return this.runQuotaScript(options);
    }
    throw new Error(`Unsupported script: ${script}`);
  }

  private async runAppendScript(options: ScriptOptions): Promise<number> {
    const [key] = options.keys;
    const [payload, maxTurnsRaw, ttlSecondsRaw] = options.arguments;
    const maxTurns = Number(maxTurnsRaw);
    const ttlSeconds = Number(ttlSecondsRaw);

    this.ensureFresh(key);
    await this.rPush(key, payload);
    if (Number.isFinite(maxTurns) && maxTurns > 0) {
      await this.lTrim(key, -maxTurns, -1);
    }
    if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
      await this.expire(key, ttlSeconds);
    }
    return this.lists.get(key)?.length ?? 0;
  }

  private async runQuotaScript(options: ScriptOptions): Promise<[number, number]> {
    const [key] = options.keys;
    const [ttlMsRaw, limitRaw] = options.arguments;
    const ttlMs = Number(ttlMsRaw);
    const limit = Number(limitRaw);

    this.ensureFresh(key);
    const count = this.counters.get(key) ?? 0;
    const next = count + 1;
    this.counters.set(key, next);
    if (next === 1 && Number.isFinite(ttlMs) && ttlMs > 0) {
      this.setExpiry(key, ttlMs);
    }
    if (Number.isFinite(limit) && limit > 0 && next > limit) {
      return [next, 0];
    }
    return [next, 1];
  }

  private resolveRange(length: number, start: number, stop: number): { startIndex: number; stopIndex: number } {
    let startIndex = start < 0 ? length + start : start;
    let stopIndex = stop < 0 ? length + stop : stop;
    if (!Number.isFinite(startIndex)) {
      startIndex = 0;
    }
    if (!Number.isFinite(stopIndex)) {
      stopIndex = length - 1;
    }
    if (startIndex < 0) {
      startIndex = 0;
    }
    if (stopIndex < 0) {
      stopIndex = -1;
    }
    if (stopIndex >= length) {
      stopIndex = length - 1;
    }
    if (startIndex >= length) {
      startIndex = length;
    }
    return { startIndex, stopIndex };
  }

  private setExpiry(key: string, ttlMs: number): void {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      this.expirations.delete(key);
      if (ttlMs === 0) {
        this.lists.delete(key);
        this.counters.delete(key);
      }
      return;
    }
    this.expirations.set(key, this.now + ttlMs);
  }

  private ensureFresh(key: string): void {
    const expiry = this.expirations.get(key);
    if (expiry !== undefined && expiry <= this.now) {
      this.lists.delete(key);
      this.counters.delete(key);
      this.expirations.delete(key);
    }
  }

  private evictExpired(): void {
    for (const [key, expiry] of [...this.expirations.entries()]) {
      if (expiry <= this.now) {
        this.lists.delete(key);
        this.counters.delete(key);
        this.expirations.delete(key);
      }
    }
  }
}

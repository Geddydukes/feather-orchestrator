import { describe, expect, it, vi } from "vitest";
import { InMemoryToolCacheStore, ToolCache } from "../../src/core/tool-cache.js";

const baseArgs = { tool: "math.add", args: { a: 1, b: 2 } } as const;

describe("ToolCache", () => {
  it("stores and returns cached results", async () => {
    const cache = new ToolCache({ store: new InMemoryToolCacheStore(), ttlSeconds: 60 });

    const decision = await cache.prepare(baseArgs);
    expect(decision.cacheable).toBe(true);
    expect(decision.hit).toBeUndefined();

    await cache.write(decision, { sum: 3 }, 60);

    const second = await cache.prepare(baseArgs);
    expect(second.cacheable).toBe(true);
    expect(second.hit?.value).toEqual({ sum: 3 });
  });

  it("expires entries after TTL", async () => {
    vi.useFakeTimers();
    try {
      const cache = new ToolCache({ store: new InMemoryToolCacheStore(), ttlSeconds: 1 });
      const decision = await cache.prepare(baseArgs);
      await cache.write(decision, { sum: 3 }, 1);

      vi.advanceTimersByTime(1500);

      const after = await cache.prepare(baseArgs);
      expect(after.hit).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips caching when arguments cannot be serialised", async () => {
    const cache = new ToolCache();
    const decision = await cache.prepare({ tool: "bad", args: { fn: () => undefined } });
    expect(decision.cacheable).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";
import { PromptCache, InMemoryPromptCacheStore } from "../../src/core/prompt-cache.js";
import { createPromptCacheKey, PROMPT_CACHE_KEY_VERSION } from "../../src/core/prompt-key.js";
import { createPromptCacheMiddleware } from "../../src/core/middleware/promptCache.js";
import type { ChatRequest } from "../../src/types.js";

describe("PromptCache", () => {
  const baseRequest: ChatRequest = {
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    temperature: 0
  };

  it("stores responses and serves subsequent hits", async () => {
    const cache = new PromptCache({ store: new InMemoryPromptCacheStore(), ttlSeconds: 60 });
    const middleware = createPromptCacheMiddleware({ cache });
    const ctx: any = {
      provider: "openai",
      model: "test-model",
      request: { ...baseRequest },
      startTs: Date.now()
    };

    const next = vi.fn(async () => {
      ctx.response = { content: "hi there" };
    });

    await middleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(ctx.promptCache).toEqual({ status: "miss", key: expect.any(String) });

    const secondCtx: any = {
      provider: "openai",
      model: "test-model",
      request: { ...baseRequest },
      startTs: Date.now()
    };
    const secondNext = vi.fn(async () => {
      secondCtx.response = { content: "should not run" };
    });

    await middleware(secondCtx, secondNext);

    expect(secondNext).not.toHaveBeenCalled();
    expect(secondCtx.response?.content).toBe("hi there");
    expect(secondCtx.promptCache).toEqual({ status: "hit", key: expect.any(String) });
  });

  it("skips caching when temperature exceeds the threshold", async () => {
    const cache = new PromptCache();
    const decision = await cache.prepare({
      provider: "openai",
      model: "test-model",
      request: { ...baseRequest, temperature: 0.9 }
    });

    expect(decision.cacheable).toBe(false);
  });

  it("skips multi-turn conversations by default", async () => {
    const cache = new PromptCache();
    const decision = await cache.prepare({
      provider: "openai",
      model: "test-model",
      request: {
        ...baseRequest,
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
          { role: "user", content: "another question" }
        ]
      }
    });

    expect(decision.cacheable).toBe(false);
  });

  it("normalizes content and prefixes keys with the cache version", () => {
    const keyA = createPromptCacheKey({
      provider: "openai",
      model: "gpt-test",
      request: {
        model: "gpt-test",
        messages: [{ role: "user", content: "Hello   world" }],
        temperature: 0
      }
    });
    const keyB = createPromptCacheKey({
      provider: "openai",
      model: "gpt-test",
      request: {
        model: "gpt-test",
        messages: [{ role: "user", content: "Hello world" }],
        temperature: 0
      }
    });

    expect(keyA).toBe(keyB);
    expect(keyA.startsWith(`prompt:${PROMPT_CACHE_KEY_VERSION}:`)).toBe(true);
  });
});

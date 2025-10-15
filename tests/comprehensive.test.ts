import { describe, it, expect, vi, beforeEach } from "vitest";
import { Feather } from "../src/core/Orchestrator.js";
import { RateLimiter } from "../src/core/limiter.js";
import { Breaker } from "../src/core/breaker.js";
import { withRetry } from "../src/core/retry.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import type { ChatProvider } from "../src/providers/base.js";
import type { ChatRequest, ChatResponse, Middleware } from "../src/types.js";

// Mock providers for testing
function createMockProvider(id: string, behavior: "success" | "fail" | "slow" | "streaming"): ChatProvider {
  const baseProvider: ChatProvider = {
    id,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      if (behavior === "fail") {
        throw new Error(`Provider ${id} failed`);
      }
      if (behavior === "slow") {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return { 
        content: `Response from ${id}`, 
        costUSD: 0.001,
        tokens: { input: 10, output: 5 }
      };
    },
    price: { inputPer1K: 0.001, outputPer1K: 0.002 }
  };

  // Only add stream method for streaming behavior
  if (behavior === "streaming") {
    return {
      ...baseProvider,
      async *stream(req: ChatRequest): AsyncIterable<{ content?: string }> {
        yield { content: "Streaming " };
        yield { content: "response " };
        yield { content: "from " };
        yield { content: id };
      }
    };
  }

  return baseProvider;
}

describe("Feather Orchestrator", () => {
  let feather: Feather;

  beforeEach(() => {
    feather = new Feather({
      providers: {
        provider1: createMockProvider("provider1", "success"),
        provider2: createMockProvider("provider2", "success"),
        failing: createMockProvider("failing", "fail"),
        slow: createMockProvider("slow", "slow"),
        streaming: createMockProvider("streaming", "streaming")
      },
      limits: {
        "provider1:model1": { rps: 10, burst: 20 },
        "provider2:model2": { rps: 5, burst: 10 }
      },
      retry: { maxAttempts: 2, baseMs: 10, maxMs: 100 },
      timeoutMs: 5000
    });
  });

  describe("Basic Chat Functionality", () => {
    it("should make successful chat requests", async () => {
      const response = await feather.chat({
        provider: "provider1",
        model: "model1",
        messages: [{ role: "user", content: "Hello" }]
      });

      expect(response.content).toBe("Response from provider1");
      expect(response.costUSD).toBe(0.001);
      expect(response.tokens).toEqual({ input: 10, output: 5 });
    });

    it("should validate input parameters", async () => {
      // Test empty messages
      await expect(feather.chat({
        provider: "provider1",
        model: "model1",
        messages: []
      })).rejects.toThrow("Messages array is required and cannot be empty");

      // Test invalid temperature
      await expect(feather.chat({
        provider: "provider1",
        model: "model1",
        messages: [{ role: "user", content: "Hello" }],
        temperature: 3
      })).rejects.toThrow("Temperature must be between 0 and 2");

      // Test invalid maxTokens
      await expect(feather.chat({
        provider: "provider1",
        model: "model1",
        messages: [{ role: "user", content: "Hello" }],
        maxTokens: 0
      })).rejects.toThrow("Max tokens must be between 1 and 100000");

      // Test invalid topP
      await expect(feather.chat({
        provider: "provider1",
        model: "model1",
        messages: [{ role: "user", content: "Hello" }],
        topP: 2
      })).rejects.toThrow("TopP must be between 0 and 1");
    });

    it("should handle unknown providers", async () => {
      await expect(feather.chat({
        provider: "unknown",
        model: "model1",
        messages: [{ role: "user", content: "Hello" }]
      })).rejects.toThrow("Unknown provider unknown");
    });
  });

  describe("Fallback Chain", () => {
    it("should try providers in sequence until one succeeds", async () => {
      const fallbackChain = feather.fallback([
        { provider: "failing", model: "model1" },
        { provider: "provider1", model: "model1" }
      ]);

      const response = await fallbackChain.chat({
        messages: [{ role: "user", content: "Hello" }]
      });

      expect(response.content).toBe("Response from provider1");
    });

    it("should fail if all providers fail", async () => {
      const fallbackChain = feather.fallback([
        { provider: "failing", model: "model1" },
        { provider: "failing", model: "model1" }
      ]);

      await expect(fallbackChain.chat({
        messages: [{ role: "user", content: "Hello" }]
      })).rejects.toThrow("Provider failing failed");
    });

    it("should work with single provider", async () => {
      const fallbackChain = feather.fallback([
        { provider: "provider1", model: "model1" }
      ]);

      const response = await fallbackChain.chat({
        messages: [{ role: "user", content: "Hello" }]
      });

      expect(response.content).toBe("Response from provider1");
    });
  });

  describe("Race Chain", () => {
    it("should return the fastest successful response", async () => {
      const raceChain = feather.race([
        { provider: "slow", model: "model1" },
        { provider: "provider1", model: "model1" }
      ]);

      const response = await raceChain.chat({
        messages: [{ role: "user", content: "Hello" }]
      });

      expect(response.content).toBe("Response from provider1");
    });

    it("should fail if all providers fail", async () => {
      const raceChain = feather.race([
        { provider: "failing", model: "model1" },
        { provider: "failing", model: "model1" }
      ]);

      await expect(raceChain.chat({
        messages: [{ role: "user", content: "Hello" }]
      })).rejects.toThrow();
    });
  });

  describe("Streaming", () => {
    it("should stream responses correctly", async () => {
      const chunks: string[] = [];
      
      for await (const delta of feather.stream.chat({
        provider: "streaming",
        model: "model1",
        messages: [{ role: "user", content: "Hello" }]
      })) {
        chunks.push(delta.content || "");
      }

      expect(chunks.join("")).toBe("Streaming response from streaming");
    });

    it("should validate streaming input", async () => {
      await expect(async () => {
        for await (const _ of feather.stream.chat({
          provider: "streaming",
          model: "model1",
          messages: []
        })) {
          // This should throw before yielding anything
        }
      }).rejects.toThrow("Messages array is required and cannot be empty");
    });

    it("should handle providers without streaming", async () => {
      // Create the stream generator
      const stream = feather.stream.chat({
        provider: "provider1",
        model: "model1",
        messages: [{ role: "user", content: "Hello" }]
      });
      
      // Try to iterate and expect it to throw
      const chunks: string[] = [];
      let error: Error | null = null;
      
      try {
        for await (const delta of stream) {
          chunks.push(delta.content || "");
        }
      } catch (e) {
        error = e as Error;
      }
      
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toContain("has no streaming");
    });
  });

  describe("Batch Processing", () => {
    it("should process multiple items with controlled concurrency", async () => {
      const items = ["item1", "item2", "item3", "item4"];
      
      const results = await feather.map(
        items,
        async (item) => {
          const response = await feather.chat({
            provider: "provider1",
            model: "model1",
            messages: [{ role: "user", content: item }]
          });
          return { item, response: response.content };
        },
        { concurrency: 2 }
      );

      expect(results).toHaveLength(4);
      expect(results[0].item).toBe("item1");
      expect(results[0].response).toBe("Response from provider1");
    });

    it("should handle empty arrays", async () => {
      const results = await feather.map(
        [],
        async (item) => ({ item }),
        { concurrency: 2 }
      );

      expect(results).toHaveLength(0);
    });
  });

  describe("Middleware", () => {
    it("should run middleware in correct order", async () => {
      const middlewareCalls: string[] = [];
      
      const middleware1: Middleware = async (ctx, next) => {
        middlewareCalls.push("before1");
        await next();
        middlewareCalls.push("after1");
      };
      
      const middleware2: Middleware = async (ctx, next) => {
        middlewareCalls.push("before2");
        await next();
        middlewareCalls.push("after2");
      };

      const featherWithMiddleware = new Feather({
        providers: {
          provider1: createMockProvider("provider1", "success")
        },
        middleware: [middleware1, middleware2]
      });

      await featherWithMiddleware.chat({
        provider: "provider1",
        model: "model1",
        messages: [{ role: "user", content: "Hello" }]
      });

      expect(middlewareCalls).toEqual(["before1", "before2", "after2", "after1"]);
    });

    it("should pass context to middleware", async () => {
      let capturedContext: any = null;
      
      const middleware: Middleware = async (ctx, next) => {
        capturedContext = ctx;
        await next();
      };

      const featherWithMiddleware = new Feather({
        providers: {
          provider1: createMockProvider("provider1", "success")
        },
        middleware: [middleware]
      });

      await featherWithMiddleware.chat({
        provider: "provider1",
        model: "model1",
        messages: [{ role: "user", content: "Hello" }]
      });

      expect(capturedContext.provider).toBe("provider1");
      expect(capturedContext.model).toBe("model1");
      expect(capturedContext.request.messages).toEqual([{ role: "user", content: "Hello" }]);
      expect(capturedContext.response?.content).toBe("Response from provider1");
      expect(capturedContext.startTs).toBeDefined();
      expect(capturedContext.endTs).toBeDefined();
    });
  });

  describe("Cost Tracking", () => {
    it("should track total cost across requests", async () => {
      expect(feather.totalCostUSD).toBe(0);

      await feather.chat({
        provider: "provider1",
        model: "model1",
        messages: [{ role: "user", content: "Hello" }]
      });

      expect(feather.totalCostUSD).toBe(0.001);

      await feather.chat({
        provider: "provider2",
        model: "model2",
        messages: [{ role: "user", content: "Hello" }]
      });

      expect(feather.totalCostUSD).toBe(0.002);
    });
  });
});

describe("Rate Limiter", () => {
  it("should enforce rate limits", async () => {
    const limiter = new RateLimiter({
      "test:model": { rps: 2, burst: 3 }
    });

    const start = Date.now();
    
    // Should allow burst
    await limiter.take("test:model");
    await limiter.take("test:model");
    await limiter.take("test:model");
    
    // Should rate limit after burst
    await limiter.take("test:model");
    
    const duration = Date.now() - start;
    expect(duration).toBeGreaterThan(400); // Should wait ~500ms for rate limit
  });

  it("should handle unknown keys", async () => {
    const limiter = new RateLimiter({});
    
    // Should not throw for unknown keys
    await expect(limiter.take("unknown:model")).resolves.toBeUndefined();
  });
});

describe("Circuit Breaker", () => {
  it("should open after threshold failures", () => {
    const breaker = new Breaker(3, 1000); // 3 failures, 1 second timeout
    
    // Should allow requests initially
    expect(breaker.canPass()).toBe(true);
    
    // Fail 3 times
    breaker.fail();
    breaker.fail();
    breaker.fail();
    
    // Should block requests
    expect(breaker.canPass()).toBe(false);
  });

  it("should recover after timeout", () => {
    const breaker = new Breaker(2, 100); // 2 failures, 100ms timeout
    
    breaker.fail();
    breaker.fail();
    
    expect(breaker.canPass()).toBe(false);
    
    // Wait for timeout
    return new Promise(resolve => {
      setTimeout(() => {
        expect(breaker.canPass()).toBe(true);
        resolve(undefined);
      }, 150);
    });
  });

  it("should reset on success", () => {
    const breaker = new Breaker(2, 1000);
    
    breaker.fail();
    breaker.fail();
    expect(breaker.canPass()).toBe(false);
    
    breaker.success();
    expect(breaker.canPass()).toBe(true);
  });
});

describe("Retry Logic", () => {
  it("should retry failed operations", async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error("Temporary failure");
      }
      return "success";
    };

    const result = await withRetry(fn, { maxAttempts: 3, baseMs: 10 });
    expect(result).toBe("success");
    expect(attempts).toBe(3);
  });

  it("should fail after max attempts", async () => {
    const fn = async () => {
      throw new Error("Permanent failure");
    };

    await expect(withRetry(fn, { maxAttempts: 2, baseMs: 10 }))
      .rejects.toThrow("Permanent failure");
  });

  it("should respect jitter settings", async () => {
    const delays: number[] = [];
    const originalSetTimeout = global.setTimeout;
    
    (global.setTimeout as any) = vi.fn((fn: Function, delay: number) => {
      delays.push(delay);
      return originalSetTimeout(fn, delay);
    });

    const fn = async () => {
      throw new Error("Test error");
    };

    try {
      await withRetry(fn, { maxAttempts: 2, baseMs: 100, jitter: "full" });
    } catch (error) {
      // Expected to fail
    }

    expect(delays.length).toBeGreaterThan(0);
    // With full jitter, delay should be between 50ms and 200ms
    expect(delays[0]).toBeGreaterThanOrEqual(50);
    expect(delays[0]).toBeLessThanOrEqual(200);

    global.setTimeout = originalSetTimeout;
  });
});

describe("Provider Registry", () => {
  it("should find providers by model name", () => {
    const registry = new ProviderRegistry();
    
    registry.add({
      key: "provider1",
      inst: createMockProvider("provider1", "success"),
      models: [
        { name: "model1", aliases: ["fast"], inputPer1K: 0.001, outputPer1K: 0.002 },
        { name: "model2", aliases: ["slow"], inputPer1K: 0.002, outputPer1K: 0.004 }
      ]
    });

    const result = registry.choose("model1");
    expect(result.entry.key).toBe("provider1");
    expect(result.model).toBe("model1");
  });

  it("should find providers by alias", () => {
    const registry = new ProviderRegistry();
    
    registry.add({
      key: "provider1",
      inst: createMockProvider("provider1", "success"),
      models: [
        { name: "model1", aliases: ["fast"], inputPer1K: 0.001, outputPer1K: 0.002 }
      ]
    });

    const result = registry.choose("fast");
    expect(result.entry.key).toBe("provider1");
    expect(result.model).toBe("model1");
  });

  it("should use cheapest policy", () => {
    const registry = new ProviderRegistry({ policy: "cheapest" });
    
    registry.add({
      key: "expensive",
      inst: createMockProvider("expensive", "success"),
      models: [
        { name: "model1", aliases: ["fast"], inputPer1K: 0.01, outputPer1K: 0.02 }
      ]
    });
    
    registry.add({
      key: "cheap",
      inst: createMockProvider("cheap", "success"),
      models: [
        { name: "model1", aliases: ["fast"], inputPer1K: 0.001, outputPer1K: 0.002 }
      ]
    });

    const result = registry.choose("fast");
    expect(result.entry.key).toBe("cheap");
  });

  it("should use round-robin policy", () => {
    const registry = new ProviderRegistry({ policy: "roundrobin" });
    
    registry.add({
      key: "provider1",
      inst: createMockProvider("provider1", "success"),
      models: [{ name: "model1", aliases: ["fast"] }]
    });
    
    registry.add({
      key: "provider2",
      inst: createMockProvider("provider2", "success"),
      models: [{ name: "model1", aliases: ["fast"] }]
    });

    const result1 = registry.choose("fast");
    const result2 = registry.choose("fast");
    
    expect(result1.entry.key).toBe("provider1");
    expect(result2.entry.key).toBe("provider2");
  });

  it("should throw error for unknown model", () => {
    const registry = new ProviderRegistry();
    
    expect(() => registry.choose("unknown")).toThrow("No provider registered for model 'unknown'");
  });
});

describe("Integration Tests", () => {
  it("should work with registry-based configuration", async () => {
    const registry = new ProviderRegistry({ policy: "first" });
    
    registry.add({
      key: "test-provider",
      inst: createMockProvider("test-provider", "success"),
      models: [
        { name: "test-model", aliases: ["fast"], inputPer1K: 0.001, outputPer1K: 0.002 }
      ]
    });

    const feather = new Feather({ registry });

    const response = await feather.chat({
      model: "fast",
      messages: [{ role: "user", content: "Hello" }]
    });

    expect(response.content).toBe("Response from test-provider");
  });

  it("should handle complex middleware chains", async () => {
    const middlewareCalls: string[] = [];
    
    const middleware1: Middleware = async (ctx, next) => {
      middlewareCalls.push("m1-before");
      await next();
      middlewareCalls.push("m1-after");
    };
    
    const middleware2: Middleware = async (ctx, next) => {
      middlewareCalls.push("m2-before");
      await next();
      middlewareCalls.push("m2-after");
    };
    
    const middleware3: Middleware = async (ctx, next) => {
      middlewareCalls.push("m3-before");
      await next();
      middlewareCalls.push("m3-after");
    };

    const feather = new Feather({
      providers: {
        provider1: createMockProvider("provider1", "success")
      },
      middleware: [middleware1, middleware2, middleware3]
    });

    await feather.chat({
      provider: "provider1",
      model: "model1",
      messages: [{ role: "user", content: "Hello" }]
    });

    expect(middlewareCalls).toEqual([
      "m1-before", "m2-before", "m3-before",
      "m3-after", "m2-after", "m1-after"
    ]);
  });
});

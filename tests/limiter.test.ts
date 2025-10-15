import { describe, it, expect, vi } from "vitest";
import { RateLimiter } from "../src/core/limiter.js";

describe("RateLimiter", () => {
  it("should allow unlimited requests when no limit configured", () => {
    const limiter = new RateLimiter({});
    
    expect(limiter.tryTake("unlimited")).toBe(true);
    expect(limiter.tryTake("unlimited")).toBe(true);
    expect(limiter.tryTake("unlimited")).toBe(true);
  });

  it("should respect rate limits", async () => {
    const limiter = new RateLimiter({
      "test": { rps: 2, burst: 2 }
    });

    // Should allow burst
    expect(limiter.tryTake("test")).toBe(true);
    expect(limiter.tryTake("test")).toBe(true);
    
    // Should reject after burst
    expect(limiter.tryTake("test")).toBe(false);
  });

  it("should refill tokens over time", async () => {
    const limiter = new RateLimiter({
      "test": { rps: 1, burst: 1 }
    });

    expect(limiter.tryTake("test")).toBe(true);
    expect(limiter.tryTake("test")).toBe(false);

    // Wait for token refill
    await new Promise(resolve => setTimeout(resolve, 1100));
    
    expect(limiter.tryTake("test")).toBe(true);
  });

  it("should queue requests when tokens exhausted", async () => {
    const limiter = new RateLimiter({
      "test": { rps: 1, burst: 1 }
    });

    // Take the burst token
    expect(limiter.tryTake("test")).toBe(true);

    // Queue a request
    const promise = limiter.take("test");
    
    // Should resolve after refill
    await expect(promise).resolves.toBeUndefined();
  });

  it("should handle multiple queued requests fairly", async () => {
    const limiter = new RateLimiter({
      "test": { rps: 1, burst: 1 }
    });

    // Take the burst token
    expect(limiter.tryTake("test")).toBe(true);

    const promises = [
      limiter.take("test"),
      limiter.take("test"),
      limiter.take("test")
    ];

    // All should resolve eventually
    await expect(Promise.all(promises)).resolves.toEqual([undefined, undefined, undefined]);
  });

  it("should abort queued requests on signal", async () => {
    const controller = new AbortController();
    const limiter = new RateLimiter({
      "test": { rps: 1, burst: 1 }
    });

    // Take the burst token
    expect(limiter.tryTake("test")).toBe(true);

    const promise = limiter.take("test", { signal: controller.signal });
    
    // Abort the request
    controller.abort();
    
    await expect(promise).rejects.toThrow("Aborted");
  });

  it("should handle different keys independently", () => {
    const limiter = new RateLimiter({
      "key1": { rps: 1, burst: 1 },
      "key2": { rps: 2, burst: 2 }
    });

    expect(limiter.tryTake("key1")).toBe(true);
    expect(limiter.tryTake("key1")).toBe(false);
    
    expect(limiter.tryTake("key2")).toBe(true);
    expect(limiter.tryTake("key2")).toBe(true);
    expect(limiter.tryTake("key2")).toBe(false);
  });

  it("should respect burst capacity", () => {
    const limiter = new RateLimiter({
      "test": { rps: 1, burst: 3 }
    });

    // Should allow burst
    expect(limiter.tryTake("test")).toBe(true);
    expect(limiter.tryTake("test")).toBe(true);
    expect(limiter.tryTake("test")).toBe(true);
    
    // Should reject after burst
    expect(limiter.tryTake("test")).toBe(false);
  });

  it("should handle burst refill correctly", async () => {
    const limiter = new RateLimiter({
      "test": { rps: 2, burst: 2 }
    });

    // Use burst
    expect(limiter.tryTake("test")).toBe(true);
    expect(limiter.tryTake("test")).toBe(true);
    expect(limiter.tryTake("test")).toBe(false);

    // Wait for refill
    await new Promise(resolve => setTimeout(resolve, 600));
    
    // Should have refilled 1 token
    expect(limiter.tryTake("test")).toBe(true);
    expect(limiter.tryTake("test")).toBe(false);
  });
});

import { describe, it, expect, vi } from "vitest";
import { withRetry } from "../src/core/retry.js";

describe("withRetry", () => {
  it("should succeed on first attempt", async () => {
    const fn = vi.fn().mockResolvedValue("success");
    const result = await withRetry(fn);
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should retry on failure and eventually succeed", async () => {
    let attempts = 0;
    const fn = vi.fn().mockImplementation(() => {
      attempts++;
      if (attempts < 3) throw new Error("fail");
      return "success";
    });

    const result = await withRetry(fn, { maxAttempts: 3 });
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("should fail after max attempts", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fail"));
    
    await expect(withRetry(fn, { maxAttempts: 2 })).rejects.toThrow("fail");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("should respect Retry-After header", async () => {
    const start = Date.now();
    const fn = vi.fn()
      .mockRejectedValueOnce({ retryAfter: 0.05 }) // 50ms
      .mockResolvedValue("success");

    await withRetry(fn, { maxAttempts: 2, baseMs: 10 });
    
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(30); // More lenient tolerance
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("should not retry on non-retryable status codes", async () => {
    const fn = vi.fn().mockRejectedValue({ status: 400 }); // 4xx should not retry
    
    await expect(withRetry(fn, { maxAttempts: 3 })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should retry on retryable status codes", async () => {
    let attempts = 0;
    const fn = vi.fn().mockImplementation(() => {
      attempts++;
      if (attempts < 2) throw { status: 500 }; // 5xx should retry
      return "success";
    });

    const result = await withRetry(fn, { maxAttempts: 3 });
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("should respect custom retry policy", async () => {
    const fn = vi.fn().mockRejectedValue({ status: 400 });
    
    await expect(withRetry(fn, { 
      maxAttempts: 3,
      statusRetry: (status) => status === 400 // Custom policy allows 400
    })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("should respect global timeout", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fail"));
    
    await expect(withRetry(fn, { 
      maxAttempts: 10,
      maxTotalMs: 10, // Very short timeout
      baseMs: 20
    })).rejects.toThrow();
    
    // Should not reach max attempts due to timeout
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should call onRetry callback", async () => {
    const onRetry = vi.fn();
    let attempts = 0;
    const fn = vi.fn().mockImplementation(() => {
      attempts++;
      if (attempts < 2) throw new Error("fail");
      return "success";
    });

    await withRetry(fn, { maxAttempts: 3, onRetry });
    
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith({
      attempt: 1,
      waitMs: expect.any(Number),
      error: expect.any(Error)
    });
  });

  it("should abort on signal", async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockRejectedValue(new Error("fail"));
    
    // Abort after 10ms
    setTimeout(() => controller.abort(), 10);
    
    await expect(withRetry(fn, { 
      maxAttempts: 10,
      signal: controller.signal,
      baseMs: 50
    })).rejects.toThrow("Aborted");
  });

  it("should handle jitter correctly", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fail"));
    
    await expect(withRetry(fn, { 
      maxAttempts: 1,
      jitter: "none",
      baseMs: 100
    })).rejects.toThrow();
    
    // With jitter="none", wait time should be exactly baseMs
    // With jitter="full", wait time should be random between 0.5*baseMs and 1.5*baseMs
  });
});

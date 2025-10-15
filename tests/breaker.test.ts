import { describe, it, expect, vi } from "vitest";
import { Breaker } from "../src/core/breaker.js";

describe("Breaker", () => {
  it("should start in closed state", () => {
    const breaker = new Breaker();
    expect(breaker.canPass()).toBe(true);
    expect(breaker.getState()).toBe("closed");
  });

  it("should open after threshold failures", () => {
    const breaker = new Breaker(3, 1000, 5000);
    
    // Fail 3 times
    breaker.fail();
    breaker.fail();
    breaker.fail();
    
    expect(breaker.canPass()).toBe(false);
    expect(breaker.getState()).toBe("open");
    expect(breaker.getFailureCount()).toBe(3);
  });

  it("should transition to half-open after cooldown", () => {
    const breaker = new Breaker(2, 50, 1000); // Reduced cooldown
    
    // Open the breaker
    breaker.fail();
    breaker.fail();
    expect(breaker.getState()).toBe("open");
    
    // Wait for cooldown
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(breaker.canPass()).toBe(true);
        expect(breaker.getState()).toBe("half");
        resolve();
      }, 75); // Reduced wait time
    });
  });

  it("should close after success in half-open state", async () => {
    const breaker = new Breaker(2, 10, 1000); // Very short cooldown
    
    // Open the breaker
    breaker.fail();
    breaker.fail();
    expect(breaker.getState()).toBe("open");
    
    // Wait for cooldown
    await new Promise(resolve => setTimeout(resolve, 15));
    
    // Transition to half-open
    breaker.canPass();
    expect(breaker.getState()).toBe("half");
    
    // Success should close it
    breaker.success();
    expect(breaker.getState()).toBe("closed");
  });

  it("should use rolling window for failure counting", async () => {
    const breaker = new Breaker(3, 1000, 20); // Very short window
    
    // Add failures
    breaker.fail();
    breaker.fail();
    breaker.fail();
    
    expect(breaker.getFailureCount()).toBe(3);
    expect(breaker.getState()).toBe("open");
    
    // Wait for window to expire
    await new Promise(resolve => setTimeout(resolve, 25));
    
    // Failures should be swept from the window
    expect(breaker.getFailureCount()).toBe(0);
  });

  it("should classify errors correctly", () => {
    const classify = vi.fn((e: any) => e.status >= 400 && e.status < 500 ? "hard" : "soft");
    const breaker = new Breaker(2, 1000, 5000, classify);
    
    // Hard error (4xx) should not count
    breaker.fail({ status: 400 });
    expect(breaker.getFailureCount()).toBe(0);
    expect(breaker.getState()).toBe("closed");
    
    // Soft error (5xx) should count
    breaker.fail({ status: 500 });
    expect(breaker.getFailureCount()).toBe(1);
    
    expect(classify).toHaveBeenCalledWith({ status: 400 });
    expect(classify).toHaveBeenCalledWith({ status: 500 });
  });

  it("should not open on hard errors", () => {
    const breaker = new Breaker(1, 1000, 5000, (e: any) => "hard");
    
    breaker.fail();
    expect(breaker.getState()).toBe("closed");
    expect(breaker.getFailureCount()).toBe(0);
  });

  it("should handle success correctly", () => {
    const breaker = new Breaker(2, 1000, 5000);
    
    breaker.fail();
    breaker.success();
    
    expect(breaker.getFailureCount()).toBe(1); // Success doesn't add to events, just sweeps
    expect(breaker.getState()).toBe("closed");
  });

  it("should handle multiple failures in rolling window", () => {
    const breaker = new Breaker(5, 1000, 200); // 200ms window
    
    // Add 4 failures
    for (let i = 0; i < 4; i++) {
      breaker.fail();
    }
    
    expect(breaker.getFailureCount()).toBe(4);
    expect(breaker.getState()).toBe("closed");
    
    // Add one more to open
    breaker.fail();
    expect(breaker.getFailureCount()).toBe(5);
    expect(breaker.getState()).toBe("open");
  });

  it("should sweep old failures from rolling window", async () => {
    const breaker = new Breaker(3, 1000, 50); // Longer window for reliability
    
    // Add failures
    breaker.fail();
    breaker.fail();
    breaker.fail();
    
    expect(breaker.getFailureCount()).toBe(3);
    
    // Wait for full window expiration
    await new Promise(resolve => setTimeout(resolve, 60));
    
    expect(breaker.getFailureCount()).toBe(0);
  });
});

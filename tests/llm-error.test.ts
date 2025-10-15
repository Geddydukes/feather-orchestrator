import { describe, it, expect } from "vitest";
import { LLMError } from "../src/types.js";

describe("LLMError", () => {
  it("should create error with basic properties", () => {
    const error = new LLMError("Test error", "openai");
    
    expect(error.message).toBe("Test error");
    expect(error.provider).toBe("openai");
    expect(error.name).toBe("LLMError");
    expect(error.retryable).toBe(true);
  });

  it("should create error with all properties", () => {
    const error = new LLMError(
      "Rate limited",
      "anthropic",
      429,
      "req-123",
      true,
      60
    );
    
    expect(error.message).toBe("Rate limited");
    expect(error.provider).toBe("anthropic");
    expect(error.status).toBe(429);
    expect(error.requestId).toBe("req-123");
    expect(error.retryable).toBe(true);
    expect(error.retryAfter).toBe(60);
  });

  it("should default retryable to true", () => {
    const error = new LLMError("Error", "provider");
    expect(error.retryable).toBe(true);
  });

  it("should allow non-retryable errors", () => {
    const error = new LLMError("Bad request", "provider", 400, undefined, false);
    expect(error.retryable).toBe(false);
  });

  it("should be instanceof Error", () => {
    const error = new LLMError("Test", "provider");
    expect(error).toBeInstanceOf(Error);
  });

  it("should preserve stack trace", () => {
    const error = new LLMError("Test", "provider");
    expect(error.stack).toBeDefined();
  });
});

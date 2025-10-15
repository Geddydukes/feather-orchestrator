import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { openai } from "../src/providers/openai.js";
import { anthropic } from "../src/providers/anthropic.js";
import { buildRegistry } from "../src/core/config.js";

// Mock fetch for testing
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("OpenAI Provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should make successful chat requests", async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Hello from OpenAI!" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 }
      })
    };
    
    mockFetch.mockResolvedValue(mockResponse);

    const provider = openai({ apiKey: "test-key" });
    const response = await provider.chat({
      model: "gpt-4",
      messages: [{ role: "user", content: "Hello" }]
    });

    expect(response.content).toBe("Hello from OpenAI!");
    expect(response.tokens).toEqual({ input: 10, output: 5 });
    expect(response.costUSD).toBeGreaterThan(0);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": "Bearer test-key"
        },
        body: expect.stringContaining('"model":"gpt-4"')
      })
    );
  });

  it("should handle API errors", async () => {
    const mockResponse = {
      ok: false,
      status: 401
    };
    
    mockFetch.mockResolvedValue(mockResponse);

    const provider = openai({ apiKey: "invalid-key" });
    
    await expect(provider.chat({
      model: "gpt-4",
      messages: [{ role: "user", content: "Hello" }]
    })).rejects.toThrow("OpenAI 401");
  });

  it("should use custom base URL", async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Hello!" } }],
        usage: { prompt_tokens: 5, completion_tokens: 3 }
      })
    };
    
    mockFetch.mockResolvedValue(mockResponse);

    const provider = openai({ 
      apiKey: "test-key",
      baseUrl: "https://custom.openai.com/v1"
    });
    
    await provider.chat({
      model: "gpt-4",
      messages: [{ role: "user", content: "Hello" }]
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://custom.openai.com/v1/chat/completions",
      expect.any(Object)
    );
  });

  it("should use custom pricing", async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Hello!" } }],
        usage: { prompt_tokens: 1000, completion_tokens: 500 }
      })
    };
    
    mockFetch.mockResolvedValue(mockResponse);

    const provider = openai({ 
      apiKey: "test-key",
      pricing: { inputPer1K: 0.01, outputPer1K: 0.02 }
    });
    
    const response = await provider.chat({
      model: "gpt-4",
      messages: [{ role: "user", content: "Hello" }]
    });

    // 1000 input tokens * 0.01 + 500 output tokens * 0.02 = 1 + 1 = 2 cents = 0.02
    expect(response.costUSD).toBe(0.02);
  });

  it("should stream responses", async () => {
    const mockStream = {
      ok: true,
      body: {
        getReader: () => ({
          read: vi.fn()
            .mockResolvedValueOnce({ value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n'), done: false })
            .mockResolvedValueOnce({ value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":" world"}}]}\n'), done: false })
            .mockResolvedValueOnce({ value: new TextEncoder().encode('data: [DONE]\n'), done: false })
            .mockResolvedValueOnce({ done: true })
        })
      }
    };
    
    mockFetch.mockResolvedValue(mockStream);

    const provider = openai({ apiKey: "test-key" });
    const chunks: string[] = [];
    
    for await (const delta of provider.stream!({
      model: "gpt-4",
      messages: [{ role: "user", content: "Hello" }]
    })) {
      chunks.push(delta.content || "");
    }

    expect(chunks.join("")).toBe("Hello world");
  });
});

describe("Anthropic Provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should make successful chat requests", async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        content: [{ text: "Hello from Claude!" }],
        usage: { input_tokens: 10, output_tokens: 5 }
      })
    };
    
    mockFetch.mockResolvedValue(mockResponse);

    const provider = anthropic({ apiKey: "test-key" });
    const response = await provider.chat({
      model: "claude-3-5-haiku",
      messages: [{ role: "user", content: "Hello" }]
    });

    expect(response.content).toBe("Hello from Claude!");
    expect(response.tokens).toEqual({ input: 10, output: 5 });
    expect(response.costUSD).toBeGreaterThan(0);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "test-key",
          "anthropic-version": "2023-06-01"
        },
        body: expect.stringContaining('"model":"claude-3-5-haiku"')
      })
    );
  });

  it("should handle API errors", async () => {
    const mockResponse = {
      ok: false,
      status: 401
    };
    
    mockFetch.mockResolvedValue(mockResponse);

    const provider = anthropic({ apiKey: "invalid-key" });
    
    await expect(provider.chat({
      model: "claude-3-5-haiku",
      messages: [{ role: "user", content: "Hello" }]
    })).rejects.toThrow("Anthropic 401");
  });

  it("should map system messages correctly", async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        content: [{ text: "Hello!" }],
        usage: { input_tokens: 5, output_tokens: 3 }
      })
    };
    
    mockFetch.mockResolvedValue(mockResponse);

    const provider = anthropic({ apiKey: "test-key" });
    
    await provider.chat({
      model: "claude-3-5-haiku",
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hello" }
      ]
    });

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(requestBody.messages).toEqual([
      { role: "user", content: "You are helpful\nHello" }
    ]);
  });

  it("should use custom pricing", async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        content: [{ text: "Hello!" }],
        usage: { input_tokens: 1000, output_tokens: 500 }
      })
    };
    
    mockFetch.mockResolvedValue(mockResponse);

    const provider = anthropic({ 
      apiKey: "test-key",
      pricing: { inputPer1K: 0.01, outputPer1K: 0.02 }
    });
    
    const response = await provider.chat({
      model: "claude-3-5-haiku",
      messages: [{ role: "user", content: "Hello" }]
    });

    // 1000 input tokens * 0.01 + 500 output tokens * 0.02 = 1 + 1 = 2 cents = 0.02
    expect(response.costUSD).toBe(0.02);
  });

  it("should stream responses", async () => {
    const mockStream = {
      ok: true,
      body: {
        getReader: () => ({
          read: vi.fn()
            .mockResolvedValueOnce({ value: new TextEncoder().encode('data: {"delta":{"text":"Hello"}}\n'), done: false })
            .mockResolvedValueOnce({ value: new TextEncoder().encode('data: {"delta":{"text":" world"}}\n'), done: false })
            .mockResolvedValueOnce({ value: new TextEncoder().encode('data: [DONE]\n'), done: false })
            .mockResolvedValueOnce({ done: true })
        })
      }
    };
    
    mockFetch.mockResolvedValue(mockStream);

    const provider = anthropic({ apiKey: "test-key" });
    const chunks: string[] = [];
    
    for await (const delta of provider.stream!({
      model: "claude-3-5-haiku",
      messages: [{ role: "user", content: "Hello" }]
    })) {
      chunks.push(delta.content || "");
    }

    expect(chunks.join("")).toBe("Hello world");
  });
});

describe("Configuration Builder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock environment variables
    process.env.OPENAI_API_KEY = "sk-test-openai";
    process.env.ANTHROPIC_API_KEY = "sk-test-anthropic";
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("should build registry from configuration", () => {
    const config = {
      policy: "cheapest" as const,
      providers: {
        openai: {
          apiKeyEnv: "OPENAI_API_KEY",
          models: [
            { 
              name: "gpt-4", 
              aliases: ["smart"], 
              inputPer1K: 0.03, 
              outputPer1K: 0.06 
            }
          ]
        },
        anthropic: {
          apiKeyEnv: "ANTHROPIC_API_KEY",
          models: [
            { 
              name: "claude-3-5-haiku", 
              aliases: ["fast"], 
              inputPer1K: 0.008, 
              outputPer1K: 0.024 
            }
          ]
        }
      }
    };

    const registry = buildRegistry(config);
    
    // Test that we can choose providers
    const openaiResult = registry.choose("smart");
    expect(openaiResult.entry.key).toBe("openai");
    expect(openaiResult.model).toBe("gpt-4");
    
    const anthropicResult = registry.choose("fast");
    expect(anthropicResult.entry.key).toBe("anthropic");
    expect(anthropicResult.model).toBe("claude-3-5-haiku");
  });

  it("should handle missing API keys", () => {
    delete process.env.OPENAI_API_KEY;
    
    const config = {
      providers: {
        openai: {
          apiKeyEnv: "OPENAI_API_KEY",
          models: [{ name: "gpt-4", aliases: ["smart"] }]
        }
      }
    };

    const registry = buildRegistry(config);
    
    // Should not have openai provider since API key is missing
    expect(() => registry.choose("smart")).toThrow("No provider registered for model 'smart'");
  });

  it("should use default API key environment variable names", () => {
    const config = {
      providers: {
        openai: {
          models: [{ name: "gpt-4", aliases: ["smart"] }]
        }
      }
    };

    const registry = buildRegistry(config);
    
    // Should use default OPENAI_API_KEY env var
    const result = registry.choose("smart");
    expect(result.entry.key).toBe("openai");
  });

  it("should handle custom base URLs", () => {
    const config = {
      providers: {
        openai: {
          baseUrl: "https://custom.openai.com/v1",
          models: [{ name: "gpt-4", aliases: ["smart"] }]
        }
      }
    };

    const registry = buildRegistry(config);
    const result = registry.choose("smart");
    
    expect(result.entry.key).toBe("openai");
    // The base URL would be used when making actual requests
  });
});

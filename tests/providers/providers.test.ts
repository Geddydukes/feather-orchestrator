import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { openai } from "../../src/providers/openai.js";
import { anthropic } from "../../src/providers/anthropic.js";
import { USER_AGENT } from "../../src/version.js";
import { LLMError } from "../../src/types.js";

const originalFetch = globalThis.fetch;

describe("provider adapters", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("wraps OpenAI errors with retry metadata", async () => {
    const response = new Response(
      JSON.stringify({ error: { message: "Rate limited" } }),
      {
        status: 429,
        headers: {
          "retry-after": "2",
          "x-request-id": "req-123"
        }
      }
    );
    const fetchMock = vi.fn(async () => response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = openai({ apiKey: "test" });

    const request = {
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0
    } satisfies Parameters<typeof provider.chat>[0];

    await expect(provider.chat(request)).rejects.toMatchObject({
      name: "LLMError",
      provider: "openai",
      status: 429,
      requestId: "req-123",
      retryable: true,
      retryAfter: 2
    } satisfies Partial<LLMError>);
  });

  it("sets the Feather user-agent header on requests", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ content: [{ text: "ok" }], usage: {} }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = anthropic({ apiKey: "test" });
    await provider.chat({ model: "claude", messages: [{ role: "user", content: "ping" }] });

    const init = fetchMock.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>)["user-agent"]).toBe(USER_AGENT);
  });

  it("threads abort signals through streaming requests", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {}\n"));
        controller.close();
      }
    });
    const fetchMock = vi.fn(async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = openai({ apiKey: "test" });
    const controller = new AbortController();
    const iterator = provider.stream!({
      model: "gpt-test",
      messages: [{ role: "user", content: "stream" }]
    }, { signal: controller.signal })[Symbol.asyncIterator]();

    await iterator.next();
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.signal).toBe(controller.signal);
  });
});

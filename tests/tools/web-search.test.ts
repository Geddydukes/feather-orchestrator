import { describe, expect, it, vi } from "vitest";
import { createWebSearchTool, type WebSearchResult } from "../../src/tools/webSearch.js";

describe("web.search tool", () => {
  it("delegates to the adapter and normalises results", async () => {
    const adapter = {
      search: vi.fn(async () => [
        { title: "Result A", url: "https://a.example", snippet: "A", score: 0.9 },
        { title: "Result B", url: "https://b.example", snippet: "B" },
      ] satisfies WebSearchResult[]),
    };
    const tool = createWebSearchTool(adapter, { defaultTopK: 3, maxTopK: 5 });
    const ctx = { metadata: { tenant: "t1" }, signal: undefined };

    const results = await tool.run({ query: "  weather paris  " }, ctx);

    expect(adapter.search).toHaveBeenCalledWith({
      query: "weather paris",
      topK: 3,
      signal: ctx.signal,
      metadata: ctx.metadata,
    });
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe("Result A");
    expect(results[0].url).toBe("https://a.example");
  });

  it("caps the requested topK at the configured maximum", async () => {
    const adapter = {
      search: vi.fn(async (request: { topK: number }) => {
        return Array.from({ length: request.topK }, (_, index) => ({
          title: `Result ${index}`,
          url: `https://example.com/${index}`,
          snippet: "Snippet",
        } satisfies WebSearchResult));
      }),
    };
    const tool = createWebSearchTool(adapter, { defaultTopK: 2, maxTopK: 4 });

    const results = await tool.run({ query: "news", topK: 10 }, { metadata: undefined, signal: undefined });
    expect(adapter.search).toHaveBeenCalledWith(
      expect.objectContaining({ topK: 4 })
    );
    expect(results).toHaveLength(4);
  });

  it("validates query length bounds", async () => {
    const adapter = { search: vi.fn(async () => []) };
    const tool = createWebSearchTool(adapter, { minQueryLength: 4, maxQueryLength: 10 });

    await expect(tool.run({ query: "hey" }, { metadata: undefined, signal: undefined })).rejects.toThrow(
      /at least 4 characters/
    );
    await expect(tool.run({ query: "x".repeat(12) }, { metadata: undefined, signal: undefined })).rejects.toThrow(
      /exceeds maximum length/
    );
  });

  it("rejects malformed adapter results", async () => {
    const adapter = {
      search: vi.fn(async () => [
        { title: "Valid", url: "https://valid", snippet: "ok" },
        { title: "", url: "https://invalid", snippet: "bad" },
      ] as unknown as WebSearchResult[]),
    };
    const tool = createWebSearchTool(adapter);

    await expect(tool.run({ query: "status" }, { metadata: undefined, signal: undefined })).rejects.toThrow(
      /missing a title/
    );
  });
});

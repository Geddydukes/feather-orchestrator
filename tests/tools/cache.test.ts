import { describe, expect, it, vi } from "vitest";
import { withToolCache } from "../../src/tools/cache.js";
import { ToolCache } from "../../src/core/tool-cache.js";
import type { Tool, ToolRunContext } from "../../src/tools/types.js";

describe("withToolCache", () => {
  it("caches tool results with the provided cache", async () => {
    const run = vi.fn(async ({ text }: { text: string }) => text.toUpperCase());
    const baseTool: Tool<{ text: string }, string> = {
      name: "upper",
      description: "uppercases text",
      cacheTtlSec: 45,
      run
    };

    const cachedTool = withToolCache(baseTool, { cache: new ToolCache() });
    const ctx: ToolRunContext = {};

    await expect(cachedTool.run({ text: "hello" }, ctx)).resolves.toBe("HELLO");
    await expect(cachedTool.run({ text: "hello" }, ctx)).resolves.toBe("HELLO");

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("can bypass caching using the enabled predicate", async () => {
    const run = vi.fn(async ({ value }: { value: number }) => value * 2);
    const baseTool: Tool<{ value: number }, number> = {
      name: "double",
      description: "doubles a value",
      cacheTtlSec: 30,
      run
    };

    const cachedTool = withToolCache(baseTool, {
      cache: new ToolCache(),
      enabled: (_args, ctx) => Boolean(ctx.metadata?.cacheable)
    });

    await expect(cachedTool.run({ value: 2 }, { metadata: { cacheable: false } })).resolves.toBe(4);
    await expect(cachedTool.run({ value: 2 }, { metadata: { cacheable: false } })).resolves.toBe(4);
    await expect(cachedTool.run({ value: 2 }, { metadata: { cacheable: true } })).resolves.toBe(4);
    await expect(cachedTool.run({ value: 2 }, { metadata: { cacheable: true } })).resolves.toBe(4);

    expect(run).toHaveBeenCalledTimes(3);
  });
});

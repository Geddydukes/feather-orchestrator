import type { Tool, ToolRunContext } from "./types.js";
import { ToolCache, isToolCache, type ToolCacheDecision, type ToolCacheOptions } from "../core/tool-cache.js";

export interface CachedToolOptions<TArgs, TResult> {
  cache: ToolCache | ToolCacheOptions;
  ttlSeconds?: number;
  enabled?: boolean | ((args: TArgs, ctx: ToolRunContext) => boolean);
  cacheArgs?: (args: TArgs, ctx: ToolRunContext) => unknown;
  serializeResult?: (result: TResult, args: TArgs, ctx: ToolRunContext) => unknown;
}

export function withToolCache<TArgs, TResult>(
  tool: Tool<TArgs, TResult>,
  options: CachedToolOptions<TArgs, TResult>
): Tool<TArgs, TResult> {
  if (!tool || typeof tool.name !== "string" || tool.name.trim() === "") {
    throw new Error("withToolCache requires a named tool");
  }
  if (!options || !options.cache) {
    throw new Error("withToolCache requires a cache configuration");
  }

  const cache = isToolCache(options.cache) ? options.cache : new ToolCache(options.cache);
  const deriveArgs = options.cacheArgs ?? ((args: TArgs) => args);
  const serializeResult = options.serializeResult ?? ((result: TResult) => result);

  const shouldUseCache = (args: TArgs, ctx: ToolRunContext): boolean => {
    if (options.enabled === undefined) {
      return true;
    }
    if (typeof options.enabled === "function") {
      return options.enabled(args, ctx);
    }
    return options.enabled;
  };

  const derivedCacheTtl = tool.cacheTtlSec ?? options.ttlSeconds ?? cache.defaultTtlSeconds;

  const resolveTtl = (): number | undefined => {
    if (derivedCacheTtl === undefined) {
      return undefined;
    }
    return derivedCacheTtl;
  };

  const run = tool.run.bind(tool);

  return {
    ...tool,
    cacheTtlSec: derivedCacheTtl,
    async run(args: TArgs, ctx: ToolRunContext): Promise<TResult> {
      if (!shouldUseCache(args, ctx)) {
        return run(args, ctx);
      }

      const ttl = resolveTtl();
      if (!ttl || ttl <= 0) {
        return run(args, ctx);
      }

      let decision: ToolCacheDecision | undefined;
      const cacheArgs = deriveArgs(args, ctx);
      try {
        decision = await cache.prepare({ tool: tool.name, args: cacheArgs });
      } catch {
        decision = { cacheable: false };
      }

      if (decision?.hit) {
        return decision.hit.value as TResult;
      }

      const result = await run(args, ctx);

      if (decision?.cacheable) {
        try {
          const value = serializeResult(result, args, ctx);
          await cache.write(decision, value, ttl);
        } catch {
          // Cache write failures should not affect tool execution.
        }
      }

      return result;
    }
  } satisfies Tool<TArgs, TResult>;
}

import type { Middleware } from "../../types.js";
import { PromptCache, type PromptCacheDecision } from "../prompt-cache.js";

export interface PromptCacheMiddlewareOptions {
  cache: PromptCache;
  onHit?: (info: { key: string; provider: string; model: string }) => void;
  onMiss?: (info: { key: string; provider: string; model: string }) => void;
  onStoreError?: (info: { key: string; provider: string; model: string; error: unknown }) => void;
}

export function createPromptCacheMiddleware(options: PromptCacheMiddlewareOptions): Middleware {
  if (!options || !options.cache) {
    throw new Error("Prompt cache middleware requires a cache instance");
  }

  return async (ctx, next) => {
    const decision = await options.cache.prepare({
      provider: ctx.provider,
      model: ctx.model,
      request: ctx.request
    });

    if (decision.hit && decision.key) {
      (ctx as any).promptCache = { status: "hit", key: decision.key };
      options.onHit?.({ key: decision.key, provider: ctx.provider, model: ctx.model });
      ctx.response = decision.hit;
      ctx.endTs = ctx.endTs ?? Date.now();
      return;
    }

    if (decision.cacheable && decision.key) {
      (ctx as any).promptCache = { status: "miss", key: decision.key };
      options.onMiss?.({ key: decision.key, provider: ctx.provider, model: ctx.model });
    } else {
      (ctx as any).promptCache = { status: "skip" };
    }

    try {
      await next();
    } finally {
      await persistResult(options, ctx, decision);
    }
  };
}

async function persistResult(
  options: PromptCacheMiddlewareOptions,
  ctx: any,
  decision: PromptCacheDecision
): Promise<void> {
  if (!decision.cacheable || !decision.key) {
    return;
  }
  if (!ctx.response || ctx.error) {
    return;
  }

  try {
    await options.cache.write(decision, ctx.response);
  } catch (error) {
    options.onStoreError?.({ key: decision.key, provider: ctx.provider, model: ctx.model, error });
  }
}

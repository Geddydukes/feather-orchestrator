
import type { ChatRequest, ChatResponse, ChatDelta, CallOpts, Middleware } from "../types";
import type { ChatProvider } from "../providers/base";
import { withRetry } from "./retry";
import { RateLimiter } from "./limiter";
import { Breaker } from "./breaker";
import { runMiddleware } from "./middleware";

export type ProviderSpec = { id: string; inst: ChatProvider; breaker: Breaker };

export interface FeatherOpts {
  providers?: Record<string, ChatProvider>;
  registry?: ProviderRegistry;
  limits?: Record<string, { rps: number; burst?: number }>;
  retry?: CallOpts["retry"];
  timeoutMs?: number;
  middleware?: Middleware[];
}

import { ProviderRegistry, type ProviderEntry } from "../providers/registry";

export class Feather {
  private providers: Record<string, ProviderSpec> = {};
  private registry?: ProviderRegistry;
  private limiter: RateLimiter;
  private retry = this.opts.retry;
  private middleware: Middleware[];
  public totalCostUSD = 0;

  constructor(private opts: FeatherOpts) {
    if (opts.registry) this.registry = opts.registry;
    if (opts.providers) {
      for (const [k, v] of Object.entries(opts.providers ?? {})) {
        this.providers[k] = { id: k, inst: v, breaker: new Breaker() };
      }
    }
    for (const [k, v] of Object.entries(opts.providers ?? {})) {
      this.providers[k] = { id: k, inst: v, breaker: new Breaker() };
    }
    this.limiter = new RateLimiter(opts.limits ?? {});
    this.middleware = opts.middleware ?? [];
  }

  async chat(args: { provider?: string; model?: string; messages: ChatRequest["messages"]; temperature?: number; maxTokens?: number; topP?: number }, call?: CallOpts): Promise<ChatResponse> {
    const p = this.providers[args.provider];
    if (!p) throw new Error(`Unknown provider ${args.provider}`);
    if (!p.breaker.canPass()) throw new Error(`Circuit open for ${args.provider}`);
    await this.limiter.take(`${p.inst.id}:${args.model}`);

    const req: ChatRequest = { model: args.model, messages: args.messages, temperature: args.temperature, maxTokens: args.maxTokens, topP: args.topP };
    const ctx: any = { provider: args.provider, model: args.model, request: req, startTs: Date.now() };

    const terminal = async () => {
      try {
        const res = await withRetry(() => p.inst.chat(req, { ...call, retry: call?.retry ?? this.retry }), call?.retry ?? this.retry);
        p.breaker.success();
        this.totalCostUSD += res.costUSD ?? 0;
        ctx.response = res;
        ctx.endTs = Date.now();
        return res;
      } catch (e) {
        p.breaker.fail();
        ctx.error = e;
        ctx.endTs = Date.now();
        throw e;
      }
    };

    return runMiddleware(this.middleware, 0, ctx, terminal) as unknown as Promise<ChatResponse>;
  }

  stream = {
    chat: async function* (this: Feather, args: { provider: string; model: string; messages: ChatRequest["messages"] }) {
      const p = this.providers[args.provider];
      if (!p?.inst.stream) throw new Error(`Provider ${args.provider} has no streaming`);
      await this.limiter.take(`${p.inst.id}:${args.model}`);
      for await (const d of p.inst.stream({ model: args.model, messages: args.messages }, {})) yield d;
    }.bind(this)
  };

  fallback(specs: Array<{ provider: string; model: string }>) {
    const self = this;
    return {
      async chat(req: Omit<Parameters<Feather["chat"]>[0], "provider" | "model">) {
        let lastErr: any;
        for (const s of specs) {
          try { return await self.chat({ ...req, ...s }); } catch (e) { lastErr = e; }
        }
        throw lastErr ?? new Error("All providers failed");
      }
    };
  }

  race(specs: Array<{ provider: string; model: string }>) {
    const self = this;
    return {
      async chat(req: Omit<Parameters<Feather["chat"]>[0], "provider" | "model">) {
        const tasks = specs.map(s => self.chat({ ...req, ...s }));
        return Promise.any(tasks);
      }
    };
  }

  async map<T, R>(items: T[], fn: (t: T) => Promise<R>, opts?: { concurrency?: number }) {
    const c = Math.max(1, opts?.concurrency ?? 4);
    const out: R[] = [];
    let i = 0;
    await Promise.all(Array.from({ length: c }).map(async () => {
      while (true) {
        const idx = i++;
        if (idx >= items.length) break;
        out[idx] = await fn(items[idx]);
      }
    }));
    return out;
  }
}

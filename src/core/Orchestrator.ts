
import type { ChatRequest, ChatResponse, ChatDelta, CallOpts, Middleware, FeatherEvent, RetryOpts } from "../types.js";
import type { ChatProvider } from "../providers/base.js";
import { withRetry } from "./retry.js";
import { RateLimiter } from "./limiter.js";
import { Breaker } from "./breaker.js";
import { runMiddleware } from "./middleware/index.js";
import { ProviderRegistry, type ProviderEntry } from "../providers/registry.js";
import { createAbortError, forwardAbortSignal } from "./abort.js";

export type ProviderSpec = { id: string; inst: ChatProvider; breaker: Breaker };

export interface FeatherOpts {
  providers?: Record<string, ChatProvider>;
  registry?: ProviderRegistry;
  limits?: Record<string, { rps: number; burst?: number }>;
  retry?: RetryOpts;
  timeoutMs?: number;
  middleware?: Middleware[];
}

export class Feather {
  private providers: Record<string, ProviderSpec> = {};
  private registry?: ProviderRegistry;
  private limiter: RateLimiter;
  private retry: RetryOpts;
  private middleware: Middleware[];
  public totalCostUSD = 0;
  public onEvent?: (e: FeatherEvent) => void;

  constructor(private opts: FeatherOpts) {
    if (opts.registry) this.registry = opts.registry;
    if (opts.providers) {
      for (const [k, v] of Object.entries(opts.providers)) {
        const breaker = new Breaker(5, 5000, 10000, this.classifyError);
        breaker.onStateChange = (state) => {
          if (state === "open") {
            this.onEvent?.({ type: "breaker.open", provider: k });
          } else if (state === "closed") {
            this.onEvent?.({ type: "breaker.close", provider: k });
          }
        };
        this.providers[k] = { 
          id: k, 
          inst: v, 
          breaker 
        };
      }
    }
    this.limiter = new RateLimiter(opts.limits ?? {});
    this.middleware = opts.middleware ?? [];
    this.retry = opts.retry ?? {};
  }

  private classifyError = (e: unknown): "soft" | "hard" => {
    const status = (e as any)?.status ?? (e as any)?.info?.status;
    if (typeof status === "number") {
      // 4xx errors are typically client errors (hard), 5xx are server errors (soft)
      return status >= 400 && status < 500 ? "hard" : "soft";
    }
    return "soft";
  };

  async chat(args: {
    provider?: string;
    model?: string;
    messages: ChatRequest["messages"];
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
  }, call?: CallOpts): Promise<ChatResponse> {
    // Input validation
    if (!args.messages || args.messages.length === 0) {
      throw new Error("Messages array is required and cannot be empty");
    }
    
    if (args.temperature !== undefined && (args.temperature < 0 || args.temperature > 2)) {
      throw new Error("Temperature must be between 0 and 2");
    }
    
    if (args.maxTokens !== undefined && args.maxTokens < 1) {
      throw new Error("MaxTokens must be greater than 0");
    }
    
    if (args.topP !== undefined && (args.topP < 0 || args.topP > 1)) {
      throw new Error("TopP must be between 0 and 1");
    }
    // Provider selection logic
    let p: ProviderSpec;
    let modelName: string;
    
    if (args.provider && args.model) {
      p = this.providers[args.provider];
      if (!p) throw new Error(`Unknown provider ${args.provider}`);
      modelName = args.model;
    } else if (this.registry) {
      const chosen = this.registry.choose(args.model);
      p = this.providers[chosen.entry.key];
      if (!p) throw new Error(`Provider ${chosen.entry.key} not configured`);
      modelName = chosen.model;
    } else {
      throw new Error("Either provider+model or registry must be provided");
    }

    if (!p.breaker.canPass()) {
      throw new Error(`Circuit open for ${p.id}`);
    }

    const ac = new AbortController();
    const unlink = forwardAbortSignal(args.signal, ac);
    const signal = ac.signal;
    const timeoutMs = args.timeoutMs ?? this.opts.timeoutMs ?? 60000;
    const timeoutId = setTimeout(() => ac.abort(), timeoutMs);

    if (signal.aborted) {
      clearTimeout(timeoutId);
      unlink();
      throw createAbortError(signal.reason);
    }

    try {
      const requestId = crypto.randomUUID();
      this.onEvent?.({ type: "call.start", provider: p.id, model: modelName, requestId });

      await this.limiter.take(`${p.inst.id}:${modelName}`, { signal });

      const req: ChatRequest = { 
        model: modelName, 
        messages: args.messages, 
        temperature: args.temperature, 
        maxTokens: args.maxTokens, 
        topP: args.topP 
      };
      
      const ctx: any = { 
        provider: p.id, 
        model: modelName, 
        request: req, 
        startTs: Date.now(),
        requestId 
      };

      const terminal = async () => {
        try {
          const res = await withRetry(
            () => p.inst.chat(req, {
              ...call,
              retry: call?.retry ?? this.retry,
              signal,
              timeoutMs
            }),
            {
              ...this.retry,
              signal,
              onRetry: (info: { attempt: number; waitMs: number; error: unknown }) => this.onEvent?.({ 
                type: "call.retry", 
                attempt: info.attempt, 
                waitMs: info.waitMs, 
                error: info.error,
                requestId 
              })
            }
          );
          
          p.breaker.success();
          this.totalCostUSD += res.costUSD ?? 0;
          ctx.response = res;
          ctx.endTs = Date.now();
          
          this.onEvent?.({ 
            type: "call.success", 
            provider: p.id, 
            model: modelName, 
            costUSD: res.costUSD,
            requestId 
          });
          
          return res;
        } catch (e) {
          p.breaker.fail(e);
          ctx.error = e;
          ctx.endTs = Date.now();
          
          this.onEvent?.({ 
            type: "call.error", 
            provider: p.id, 
            model: modelName, 
            error: e,
            requestId 
          });
          
          throw e;
        }
      };

      return runMiddleware(this.middleware, 0, ctx, terminal) as unknown as Promise<ChatResponse>;
    } finally {
      clearTimeout(timeoutId);
      unlink();
    }
  }

  stream = {
    chat: async function* (this: Feather, args: { 
      provider: string; 
      model: string; 
      messages: ChatRequest["messages"];
      signal?: AbortSignal;
    }) {
      // Input validation
      if (!args.messages || args.messages.length === 0) {
        throw new Error("Messages array is required and cannot be empty");
      }
      
      const p = this.providers[args.provider];
      if (!p?.inst.stream) throw new Error(`Provider ${args.provider} has no streaming`);
      
      await this.limiter.take(`${p.inst.id}:${args.model}`, { signal: args.signal });
      
      for await (const d of p.inst.stream({ 
        model: args.model, 
        messages: args.messages 
      }, { signal: args.signal })) {
        yield d;
      }
    }.bind(this)
  };

  fallback(specs: Array<{ provider: string; model: string }>) {
    const self = this;
    return {
      async chat(req: Omit<Parameters<Feather["chat"]>[0], "provider" | "model">) {
        let lastErr: any;
        for (const s of specs) {
          try { 
            return await self.chat({ ...req, ...s }); 
          } catch (e) { 
            lastErr = e; 
          }
        }
        throw lastErr ?? new Error("All providers failed");
      }
    };
  }

  race(specs: Array<{ provider: string; model: string }>) {
    const self = this;
    return {
      async chat(req: Omit<Parameters<Feather["chat"]>[0], "provider" | "model">) {
        if (!specs.length) {
          throw new Error("Feather.race requires at least one provider specification");
        }

        if (req.signal?.aborted) {
          throw createAbortError(req.signal.reason);
        }

        const controllers = specs.map(() => new AbortController());
        const cleanups: Array<() => void> = [];
        const errors: unknown[] = new Array(specs.length);
        let pending = specs.length;
        let settled = false;

        const abortLosers = (winnerIndex: number | null, reason?: unknown) => {
          controllers.forEach((controller, index) => {
            if (index === winnerIndex) {
              return;
            }
            if (!controller.signal.aborted) {
              controller.abort(reason);
            }
          });
        };

        const runCleanups = () => {
          while (cleanups.length) {
            const cleanup = cleanups.pop();
            cleanup?.();
          }
        };

        return await new Promise<ChatResponse>((resolve, reject) => {
          const rejectOnce = (error: unknown) => {
            if (settled) return;
            settled = true;
            abortLosers(null, error);
            runCleanups();
            reject(error);
          };

          const handleAbort = () => {
            rejectOnce(createAbortError(req.signal?.reason));
          };

          if (req.signal) {
            if (req.signal.aborted) {
              handleAbort();
              return;
            }
            req.signal.addEventListener("abort", handleAbort, { once: true });
            cleanups.push(() => req.signal?.removeEventListener("abort", handleAbort));
          }

          specs.forEach((spec, index) => {
            const controller = controllers[index];
            cleanups.push(forwardAbortSignal(req.signal, controller));

            Promise.resolve()
              .then(() => self.chat({ ...req, ...spec, signal: controller.signal }))
              .then((response) => {
                if (settled) {
                  return;
                }
                settled = true;
                abortLosers(index);
                runCleanups();
                resolve(response);
              })
              .catch((error) => {
                if (settled) {
                  return;
                }
                errors[index] = error;
                pending -= 1;
                if (pending === 0) {
                  settled = true;
                  abortLosers(null);
                  runCleanups();
                  const filtered = errors.filter((err) => err !== undefined);
                  if (filtered.length === 1) {
                    reject(filtered[0]);
                  } else {
                    reject(new AggregateError(filtered, "All providers failed"));
                  }
                }
              });
          });
        });
      }
    };
  }

  async map<T, R>(items: T[], fn: (t: T) => Promise<R>, opts?: { 
    concurrency?: number; 
    signal?: AbortSignal 
  }) {
    const c = Math.max(1, opts?.concurrency ?? 4);
    const out: R[] = [];
    let i = 0;
    
    await Promise.all(Array.from({ length: c }).map(async () => {
      while (true) {
        if (opts?.signal?.aborted) throw new Error("Aborted");
        
        const idx = i++;
        if (idx >= items.length) break;
        
        try {
          out[idx] = await fn(items[idx]);
        } catch (e) {
          throw e;
        }
      }
    }));
    
    return out;
  }
}

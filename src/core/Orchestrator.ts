
import type { ChatRequest, ChatResponse, ChatDelta, CallOpts, Middleware, FeatherEvent, RetryOpts } from "../types.js";
import type { ChatProvider } from "../providers/base.js";
import type {
  MemoryContext,
  MemoryContextRequest,
  MemoryManager,
  MemoryMessageInput,
  MemoryWriteOptions
} from "../memory/types.js";
import { withRetry } from "./retry.js";
import { RateLimiter } from "./limiter.js";
import { Breaker } from "./breaker.js";
import { runMiddleware } from "./middleware.js";
import { ProviderRegistry, type ProviderEntry } from "../providers/registry.js";

export type ProviderSpec = { id: string; inst: ChatProvider; breaker: Breaker };

export interface FeatherOpts {
  providers?: Record<string, ChatProvider>;
  registry?: ProviderRegistry;
  limits?: Record<string, { rps: number; burst?: number }>;
  retry?: RetryOpts;
  timeoutMs?: number;
  middleware?: Middleware[];
  memory?: MemoryManager;
  defaultSessionTTLSeconds?: number;
  defaultContextRequest?: MemoryContextRequest;
}

export interface SessionOptions {
  id: string;
  userId?: string;
  metadata?: Record<string, unknown>;
  ttlSeconds?: number;
  saveMessages?: boolean;
  context?: MemoryContextRequest;
  includeSummaryAsSystemMessage?: boolean;
}

export class Feather {
  private providers: Record<string, ProviderSpec> = {};
  private registry?: ProviderRegistry;
  private limiter: RateLimiter;
  private retry: RetryOpts;
  private middleware: Middleware[];
  public totalCostUSD = 0;
  public onEvent?: (e: FeatherEvent) => void;
  private memory?: MemoryManager;

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
    this.memory = opts.memory;
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
    session?: SessionOptions;
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
    const signal = args.signal ?? ac.signal;
    const timeoutMs = args.timeoutMs ?? this.opts.timeoutMs ?? 60000;
    const timeoutId = setTimeout(() => ac.abort(), timeoutMs);

    try {
      const requestId = crypto.randomUUID();
      this.onEvent?.({ type: "call.start", provider: p.id, model: modelName, requestId });

      await this.limiter.take(`${p.inst.id}:${modelName}`, { signal });

      const context = await this.prepareContext(args.session);

      const combinedMessages = context
        ? this.mergeContextMessages(context, args.messages, args.session)
        : args.messages;

      const req: ChatRequest = {
        model: modelName,
        messages: combinedMessages,
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
          
          await this.persistMemory(args.session, args.messages, res);
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
    }
  }

  private async prepareContext(session?: SessionOptions): Promise<MemoryContext | undefined> {
    if (!this.memory || !session?.id) return undefined;
    try {
      const request: MemoryContextRequest | undefined = session.context
        ? { ...this.opts.defaultContextRequest, ...session.context }
        : this.opts.defaultContextRequest;
      return await this.memory.loadContext(session.id, request);
    } catch (err) {
      console.warn("Feather memory loadContext failed", err);
      return undefined;
    }
  }

  private mergeContextMessages(
    context: MemoryContext,
    freshMessages: ChatRequest["messages"],
    session?: SessionOptions
  ): ChatRequest["messages"] {
    const includeSummary = session?.includeSummaryAsSystemMessage ?? true;
    const history = context.messages.map((msg) => ({ role: msg.role, content: msg.content }));
    const summaryPrefix = includeSummary && context.summary ? [{ role: "system" as const, content: context.summary }] : [];
    return [...summaryPrefix, ...history, ...freshMessages];
  }

  private async persistMemory(
    session: SessionOptions | undefined,
    requestMessages: ChatRequest["messages"],
    response: ChatResponse
  ): Promise<void> {
    if (!this.memory || !session?.id || session.saveMessages === false) {
      return;
    }

    const ttlSeconds = session.ttlSeconds ?? this.opts.defaultSessionTTLSeconds;
    const writeOpts: MemoryWriteOptions = {
      metadata: session.metadata,
      userId: session.userId,
      ttlSeconds
    };

    const toPersist: MemoryMessageInput[] = [];
    for (const msg of requestMessages) {
      if (msg.role === "system") continue;
      toPersist.push({ role: msg.role, content: msg.content });
    }

    if (response?.content) {
      toPersist.push({
        role: "assistant",
        content: response.content,
        tokens: response.tokens?.output
      });
    }

    if (toPersist.length === 0) {
      try {
        await this.memory.touchSession(session.id, ttlSeconds);
      } catch (err) {
        console.warn("Feather memory touchSession failed", err);
      }
      return;
    }

    try {
      await this.memory.appendMessages(session.id, toPersist, writeOpts);
    } catch (err) {
      console.warn("Feather memory appendMessages failed", err);
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
        const tasks = specs.map(s => self.chat({ ...req, ...s }));
        return Promise.any(tasks);
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

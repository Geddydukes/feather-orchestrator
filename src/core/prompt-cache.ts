import type { ChatRequest, ChatResponse } from "../types.js";
import { createPromptCacheKey } from "./prompt-key.js";

export interface PromptCacheRecord {
  response: ChatResponse;
  createdAt: number;
}

export interface PromptCacheStore {
  get(key: string): Promise<PromptCacheRecord | undefined> | PromptCacheRecord | undefined;
  set(key: string, record: PromptCacheRecord, ttlSeconds?: number): Promise<void> | void;
  delete?(key: string): Promise<void> | void;
}

export interface PromptCacheOptions {
  ttlSeconds?: number;
  maxTemperature?: number;
  allowMultiStep?: boolean;
  enabled?: boolean;
  store?: PromptCacheStore;
}

export interface PromptCacheContext {
  provider: string;
  model: string;
  request: ChatRequest;
}

export interface PromptCacheDecision {
  cacheable: boolean;
  key?: string;
  hit?: ChatResponse;
}

interface InternalRecord {
  response: ChatResponse;
  expiresAt?: number;
}

export class InMemoryPromptCacheStore implements PromptCacheStore {
  private readonly store = new Map<string, InternalRecord>();

  async get(key: string): Promise<PromptCacheRecord | undefined> {
    const entry = this.store.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return { response: cloneResponse(entry.response), createdAt: Date.now() };
  }

  async set(key: string, record: PromptCacheRecord, ttlSeconds?: number): Promise<void> {
    const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined;
    this.store.set(key, {
      response: cloneResponse(record.response),
      expiresAt
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

const DEFAULT_TTL_SECONDS = 300;
const DEFAULT_MAX_TEMPERATURE = 0.3;

export class PromptCache {
  private readonly ttlSeconds: number;
  private readonly maxTemperature: number;
  private readonly allowMultiStep: boolean;
  private readonly enabled: boolean;
  private readonly store: PromptCacheStore;

  constructor(options: PromptCacheOptions = {}) {
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.maxTemperature = options.maxTemperature ?? DEFAULT_MAX_TEMPERATURE;
    this.allowMultiStep = options.allowMultiStep ?? false;
    this.enabled = options.enabled ?? true;
    this.store = options.store ?? new InMemoryPromptCacheStore();
  }

  async prepare(context: PromptCacheContext): Promise<PromptCacheDecision> {
    if (!this.enabled) {
      return { cacheable: false };
    }

    if (!this.isCacheableRequest(context.request)) {
      return { cacheable: false };
    }

    const key = createPromptCacheKey({
      provider: context.provider,
      model: context.model,
      request: context.request
    });

    const cached = await this.store.get(key);
    if (cached) {
      return { cacheable: true, key, hit: cloneResponse(cached.response) };
    }

    return { cacheable: true, key };
  }

  async write(decision: PromptCacheDecision, response: ChatResponse): Promise<void> {
    if (!decision.cacheable || !decision.key) {
      return;
    }
    await this.store.set(decision.key, {
      response: cloneResponse(response),
      createdAt: Date.now()
    }, this.ttlSeconds);
  }

  isCacheableRequest(request: ChatRequest): boolean {
    if (!request || !Array.isArray(request.messages) || request.messages.length === 0) {
      return false;
    }

    const temperature = request.temperature ?? 0;
    if (temperature > this.maxTemperature) {
      return false;
    }

    if (!this.allowMultiStep) {
      let userMessages = 0;
      for (const message of request.messages) {
        if (message.role === "assistant" || message.role === "tool") {
          return false;
        }
        if (message.role === "user") {
          userMessages += 1;
        }
      }
      if (userMessages !== 1) {
        return false;
      }
      const last = request.messages[request.messages.length - 1];
      if (last.role !== "user") {
        return false;
      }
    }

    return true;
  }
}

function cloneResponse(response: ChatResponse): ChatResponse {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(response);
  }
  return JSON.parse(JSON.stringify(response));
}

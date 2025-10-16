import { createHash } from "node:crypto";

export interface ToolCacheRecord {
  value: unknown;
  createdAt: number;
}

export interface ToolCacheStore {
  get(key: string): Promise<ToolCacheRecord | undefined> | ToolCacheRecord | undefined;
  set(key: string, record: ToolCacheRecord, ttlSeconds?: number): Promise<void> | void;
  delete?(key: string): Promise<void> | void;
}

export interface ToolCacheOptions {
  enabled?: boolean;
  ttlSeconds?: number;
  store?: ToolCacheStore;
}

export interface ToolCacheRequest {
  tool: string;
  args: unknown;
}

export interface ToolCacheDecision {
  cacheable: boolean;
  key?: string;
  hit?: ToolCacheRecord;
}

interface InternalRecord {
  value: unknown;
  createdAt: number;
  expiresAt?: number;
}

const DEFAULT_TTL_SECONDS = 300;

export class InMemoryToolCacheStore implements ToolCacheStore {
  private readonly store = new Map<string, InternalRecord>();

  async get(key: string): Promise<ToolCacheRecord | undefined> {
    const entry = this.store.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return { value: cloneValue(entry.value), createdAt: entry.createdAt };
  }

  async set(key: string, record: ToolCacheRecord, ttlSeconds?: number): Promise<void> {
    const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined;
    this.store.set(key, {
      value: cloneValue(record.value),
      createdAt: record.createdAt,
      expiresAt
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

export class ToolCache {
  private readonly enabled: boolean;
  private readonly ttlSeconds: number;
  private readonly store: ToolCacheStore;

  constructor(options: ToolCacheOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.store = options.store ?? new InMemoryToolCacheStore();
  }

  get defaultTtlSeconds(): number {
    return this.ttlSeconds;
  }

  async prepare(request: ToolCacheRequest): Promise<ToolCacheDecision> {
    if (!this.enabled) {
      return { cacheable: false };
    }

    if (!request || typeof request.tool !== "string" || request.tool.trim() === "") {
      return { cacheable: false };
    }

    let key: string;
    try {
      key = createToolCacheKey(request);
    } catch {
      return { cacheable: false };
    }

    const record = await this.store.get(key);
    if (record) {
      return { cacheable: true, key, hit: { value: cloneValue(record.value), createdAt: record.createdAt } };
    }

    return { cacheable: true, key };
  }

  async write(decision: ToolCacheDecision, value: unknown, ttlSeconds?: number): Promise<void> {
    if (!this.enabled || !decision.cacheable || !decision.key) {
      return;
    }

    const ttl = resolveTtl(ttlSeconds ?? this.ttlSeconds);
    if (ttl <= 0) {
      return;
    }

    await this.store.set(decision.key, { value: cloneValue(value), createdAt: Date.now() }, ttl);
  }

  async delete(request: ToolCacheRequest): Promise<void> {
    if (!this.enabled || typeof this.store.delete !== "function") {
      return;
    }
    try {
      const key = createToolCacheKey(request);
      await this.store.delete(key);
    } catch {
      // Swallow serialization errors to keep cache best-effort.
    }
  }
}

export function isToolCache(value: unknown): value is ToolCache {
  return value instanceof ToolCache;
}

export interface ToolCacheKeyInput {
  tool: string;
  args: unknown;
}

export function createToolCacheKey(input: ToolCacheKeyInput): string {
  if (!input.tool || typeof input.tool !== "string") {
    throw new Error("Tool cache key requires a tool name");
  }
  const normalizedTool = input.tool.trim();
  const argsHash = hashArgs(input.args);
  return `${normalizedTool}:${argsHash}`;
}

function hashArgs(args: unknown): string {
  const serialized = stableStringify(args);
  return createHash("sha256").update(serialized).digest("hex");
}

function stableStringify(value: unknown): string {
  const stack = new Set<object>();

  const stringify = (input: unknown): string => {
    if (input === null || typeof input === "number" || typeof input === "boolean") {
      return JSON.stringify(input);
    }
    if (typeof input === "string") {
      return JSON.stringify(input);
    }
    if (typeof input === "bigint") {
      return JSON.stringify(input.toString());
    }
    if (input === undefined) {
      return "undefined";
    }
    if (typeof input === "symbol" || typeof input === "function") {
      throw new Error("Unsupported cache argument type");
    }
    if (Array.isArray(input)) {
      return `[${input.map((item) => stringify(item)).join(",")}]`;
    }
    if (input instanceof Date) {
      return JSON.stringify(input.toISOString());
    }
    if (input instanceof RegExp) {
      return JSON.stringify(input.toString());
    }
    if (typeof input === "object") {
      if (stack.has(input as object)) {
        throw new Error("Cannot cache circular structures");
      }
      stack.add(input as object);
      const entries = Object.keys(input as Record<string, unknown>)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stringify((input as Record<string, unknown>)[key])}`);
      stack.delete(input as object);
      return `{${entries.join(",")}}`;
    }
    return JSON.stringify(input);
  };

  return stringify(value);
}

function cloneValue<T>(value: T): T {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function resolveTtl(ttl: number | undefined): number {
  if (ttl === undefined || Number.isNaN(ttl)) {
    return 0;
  }
  if (!Number.isFinite(ttl)) {
    return Math.max(0, Math.floor(ttl));
  }
  return Math.max(0, Math.floor(ttl));
}

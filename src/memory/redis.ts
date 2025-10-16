import { createClient, type RedisClientType } from "redis";
import {
  type BaseMemoryOptions,
  type MemoryContext,
  type MemoryContextRequest,
  type MemoryManager,
  type MemoryMessage,
  type MemoryMessageInput,
  type MemorySession,
  type MemoryStats,
  type MemoryWriteOptions,
  type SessionFilter
} from "./types.js";
import {
  DEFAULT_MAX_MESSAGES,
  computeContext,
  defaultTokenizer,
  deserializeMessage,
  fromJson,
  realizeMessage,
  serializeMessage,
  time,
  toJson,
  toMemorySession
} from "./utils.js";

export interface RedisMemoryManagerOptions extends BaseMemoryOptions {
  url?: string;
  client?: RedisClientType;
  keyPrefix?: string;
  cleanupBatchSize?: number;
}

const DEFAULT_PREFIX = "feather:memory";

export class RedisMemoryManager implements MemoryManager {
  private client: RedisClientType;
  private ready: Promise<void>;
  private options: Required<Pick<BaseMemoryOptions, "maxMessages" | "defaultTTLSeconds" | "contextWindowTokens">> &
    Partial<BaseMemoryOptions> & { keyPrefix: string; cleanupBatchSize: number };

  constructor(opts: RedisMemoryManagerOptions = {}) {
    this.client = opts.client ?? createClient({ url: opts.url });
    this.ready = this.client.connect();
    this.options = {
      maxMessages: opts.maxMessages ?? DEFAULT_MAX_MESSAGES,
      defaultTTLSeconds: opts.defaultTTLSeconds ?? 60 * 60 * 24,
      contextWindowTokens: opts.contextWindowTokens ?? undefined,
      compressor: opts.compressor,
      tokenizer: opts.tokenizer ?? defaultTokenizer,
      hooks: opts.hooks,
      keyPrefix: opts.keyPrefix ?? DEFAULT_PREFIX,
      cleanupBatchSize: opts.cleanupBatchSize ?? 100
    } as typeof this.options;
  }

  private async ensureClient() {
    try {
      await this.ready;
    } catch (err) {
      if ((err as any)?.code === "ERR_CLIENT_CLOSED") {
        this.ready = this.client.connect();
        await this.ready;
      } else {
        throw err;
      }
    }
  }

  private sessionKey(sessionId: string) {
    return `${this.options.keyPrefix}:session:${sessionId}`;
  }

  private messagesKey(sessionId: string) {
    return `${this.options.keyPrefix}:session:${sessionId}:messages`;
  }

  private async upsertSession(sessionId: string, opts?: MemoryWriteOptions): Promise<void> {
    const key = this.sessionKey(sessionId);
    const now = new Date().toISOString();
    const ttl = opts?.ttlSeconds ?? this.options.defaultTTLSeconds;
    const updates: Record<string, string> = {
      updatedAt: now
    };
    if (opts?.userId) updates.userId = opts.userId;
    if (opts?.metadata) updates.metadata = toJson(opts.metadata);
    const exists = await this.client.exists(key);
    if (!exists) {
      updates.createdAt = now;
    }
    if (ttl) {
      updates.expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    }
    await this.client.hSet(key, updates);
    if (ttl) {
      await this.client.expire(key, ttl);
      await this.client.expire(this.messagesKey(sessionId), ttl);
    }
  }

  async appendMessages(sessionId: string, inputs: MemoryMessageInput[], opts?: MemoryWriteOptions): Promise<MemoryMessage[]> {
    if (inputs.length === 0) return [];
    await this.ensureClient();

    const { durationMs, value } = await time(async () => {
      await this.upsertSession(sessionId, opts);
      const key = this.messagesKey(sessionId);
      const startSequence = Number(await this.client.hGet(this.sessionKey(sessionId), "messageCount")) || 0;
      const stored = inputs.map((input, idx) => realizeMessage(sessionId, input, startSequence + idx, this.options.tokenizer));
      if (stored.length > 0) {
        await this.client.rPush(key, stored.map((msg) => toJson(serializeMessage(msg))));
        await this.client.lTrim(key, -this.options.maxMessages, -1);
        await this.client.hIncrBy(this.sessionKey(sessionId), "messageCount", stored.length);
      }
      return stored;
    });

    this.options.hooks?.onWrite?.({ sessionId, messages: value.length, durationMs });
    return value;
  }

  async loadContext(sessionId: string, opts?: MemoryContextRequest): Promise<MemoryContext> {
    await this.ensureClient();
    const key = this.messagesKey(sessionId);
    const { durationMs, value } = await time(async () => {
      const rawMessages = await this.client.lRange(key, 0, -1);
      const messages = rawMessages.map((item: string) => deserializeMessage(JSON.parse(item)));
      return computeContext(sessionId, messages, opts, {
        maxMessages: this.options.maxMessages,
        contextWindowTokens: this.options.contextWindowTokens,
        compressor: this.options.compressor,
        tokenizer: this.options.tokenizer
      });
    });

    this.options.hooks?.onRead?.({ sessionId, messages: value.messages.length, strategy: opts?.strategy ?? "hybrid", durationMs });

    if (opts?.includeMetadata) {
      const meta = await this.client.hGetAll(this.sessionKey(sessionId));
      return {
        ...value,
        metadata: meta?.metadata ? JSON.parse(meta.metadata) : undefined,
        expiresAt: meta?.expiresAt ? new Date(meta.expiresAt) : undefined
      };
    }

    return value;
  }

  async listSessions(filter?: SessionFilter): Promise<MemorySession[]> {
    await this.ensureClient();
    const sessions: MemorySession[] = [];
    const pattern = `${this.options.keyPrefix}:session:*`;
    for await (const key of this.client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
      if (key.endsWith(":messages")) continue;
      const sessionId = key.split(":").pop()!;
      const data = await this.client.hGetAll(key);
      if (!data || Object.keys(data).length === 0) continue;
      const session = toMemorySession(sessionId, {
        userId: data.userId,
        metadata: fromJson<Record<string, unknown>>(data.metadata ?? null),
        createdAt: new Date(data.createdAt ?? Date.now()),
        updatedAt: new Date(data.updatedAt ?? Date.now()),
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
        messageCount: Number(data.messageCount ?? 0)
      });
      if (filter?.userId && session.userId !== filter.userId) continue;
      if (filter?.before && session.updatedAt >= filter.before) continue;
      if (filter?.after && session.updatedAt <= filter.after) continue;
      sessions.push(session);
    }
    sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return sessions;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.ensureClient();
    const key = this.sessionKey(sessionId);
    const messagesKey = this.messagesKey(sessionId);
    const length = await this.client.lLen(messagesKey);
    await this.client.del(key, messagesKey);
    this.options.hooks?.onDelete?.({ sessionId, messages: Number(length) });
  }

  async deleteMessages(sessionId: string, predicate: (message: MemoryMessage) => boolean): Promise<number> {
    await this.ensureClient();
    const key = this.messagesKey(sessionId);
    const raw = await this.client.lRange(key, 0, -1);
    if (raw.length === 0) return 0;
    const messages = raw.map((item: string) => deserializeMessage(JSON.parse(item)));
    const kept = messages.filter((msg) => !predicate(msg));
    await this.client.del(key);
    if (kept.length > 0) {
      await this.client.rPush(key, kept.map((msg) => toJson(serializeMessage(msg))));
    }
    const deleted = messages.length - kept.length;
    if (deleted > 0) {
      await this.client.hIncrBy(this.sessionKey(sessionId), "messageCount", -deleted);
      this.options.hooks?.onDelete?.({ sessionId, messages: deleted });
    }
    return deleted;
  }

  async touchSession(sessionId: string, ttlSeconds?: number): Promise<void> {
    await this.ensureClient();
    const ttl = ttlSeconds ?? this.options.defaultTTLSeconds;
    const key = this.sessionKey(sessionId);
    const messagesKey = this.messagesKey(sessionId);
    if (ttl) {
      await this.client.expire(key, ttl);
      await this.client.expire(messagesKey, ttl);
      await this.client.hSet(key, "expiresAt", new Date(Date.now() + ttl * 1000).toISOString());
    }
    await this.client.hSet(key, "updatedAt", new Date().toISOString());
  }

  async pruneExpired(): Promise<number> {
    await this.ensureClient();
    let removed = 0;
    const now = Date.now();
    const pattern = `${this.options.keyPrefix}:session:*`;
    for await (const key of this.client.scanIterator({ MATCH: pattern, COUNT: this.options.cleanupBatchSize })) {
      if (key.endsWith(":messages")) continue;
      const expiresAt = await this.client.hGet(key, "expiresAt");
      if (expiresAt && new Date(expiresAt).getTime() <= now) {
        const sessionId = key.split(":").pop()!;
        await this.deleteSession(sessionId);
        removed += 1;
      }
    }
    return removed;
  }

  async stats(): Promise<MemoryStats> {
    await this.ensureClient();
    let messages = 0;
    let sessions = 0;
    const pattern = `${this.options.keyPrefix}:session:*:messages`;
    for await (const key of this.client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
      messages += Number(await this.client.lLen(key));
      sessions += 1;
    }
    return {
      sessions,
      messages,
      expiredSessions: 0
    };
  }

  async close(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.quit();
    }
  }
}

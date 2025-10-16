import {
  type BaseMemoryOptions,
  type MemoryContext,
  type MemoryContextRequest,
  type MemoryDeleteOptions,
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
  realizeMessage,
  time,
  toMemorySession
} from "./utils.js";

interface StoredSession {
  session: MemorySession;
  messages: MemoryMessage[];
}

export interface InMemoryMemoryManagerOptions extends BaseMemoryOptions {
  cleanupIntervalMs?: number;
}

export class InMemoryMemoryManager implements MemoryManager {
  private sessions = new Map<string, StoredSession>();
  private cleanupTimer?: NodeJS.Timeout;

  private options: Required<Pick<BaseMemoryOptions, "maxMessages" | "defaultTTLSeconds" | "contextWindowTokens">> &
    Partial<BaseMemoryOptions> &
    { cleanupIntervalMs: number };

  constructor(opts: InMemoryMemoryManagerOptions = {}) {
    this.options = {
      maxMessages: opts.maxMessages ?? DEFAULT_MAX_MESSAGES,
      defaultTTLSeconds: opts.defaultTTLSeconds ?? 60 * 60 * 24,
      contextWindowTokens: opts.contextWindowTokens ?? undefined,
      compressor: opts.compressor,
      tokenizer: opts.tokenizer ?? defaultTokenizer,
      hooks: opts.hooks,
      cleanupIntervalMs: opts.cleanupIntervalMs ?? 60_000
    } as typeof this.options;

    if (this.options.cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        void this.pruneExpired();
      }, this.options.cleanupIntervalMs).unref();
    }
  }

  private getOrCreateSession(sessionId: string, opts?: MemoryWriteOptions): StoredSession {
    let existing = this.sessions.get(sessionId);
    if (existing) {
      this.ensureNotExpired(sessionId, existing.session);
      return existing;
    }

    const now = new Date();
    const ttl = opts?.ttlSeconds ?? this.options.defaultTTLSeconds;
    const expiresAt = ttl ? new Date(now.getTime() + ttl * 1000) : undefined;
    const session: MemorySession = {
      sessionId,
      userId: opts?.userId,
      metadata: opts?.metadata,
      createdAt: now,
      updatedAt: now,
      expiresAt,
      messageCount: 0
    };
    existing = { session, messages: [] };
    this.sessions.set(sessionId, existing);
    return existing;
  }

  private ensureNotExpired(sessionId: string, session: MemorySession): void {
    if (session.expiresAt && session.expiresAt.getTime() <= Date.now()) {
      this.sessions.delete(sessionId);
    }
  }

  private applyWriteHooks(sessionId: string, count: number, durationMs: number) {
    this.options.hooks?.onWrite?.({ sessionId, messages: count, durationMs });
  }

  private applyReadHooks(sessionId: string, count: number, strategy: MemoryContextRequest["strategy"] | undefined, durationMs: number) {
    this.options.hooks?.onRead?.({ sessionId, messages: count, strategy: strategy ?? "hybrid", durationMs });
  }

  private applyDeleteHooks(sessionId: string, count: number) {
    this.options.hooks?.onDelete?.({ sessionId, messages: count });
  }

  async appendMessages(sessionId: string, inputs: MemoryMessageInput[], opts?: MemoryWriteOptions): Promise<MemoryMessage[]> {
    if (inputs.length === 0) return [];

    const { durationMs, value } = await time(() => {
      const session = this.getOrCreateSession(sessionId, opts);
      if (opts?.metadata) {
        session.session.metadata = { ...(session.session.metadata ?? {}), ...opts.metadata };
      }
      if (opts?.userId) {
        session.session.userId = opts.userId;
      }
      const ttl = opts?.ttlSeconds ?? this.options.defaultTTLSeconds;
      if (ttl) {
        session.session.expiresAt = new Date(Date.now() + ttl * 1000);
      }

      const startSequence = session.session.messageCount;
      const storedMessages = inputs.map((input, idx) =>
        realizeMessage(sessionId, input, startSequence + idx, this.options.tokenizer)
      );

      for (const msg of storedMessages) {
        session.messages.push(msg);
      }

      if (session.messages.length > this.options.maxMessages) {
        const diff = session.messages.length - this.options.maxMessages;
        session.messages.splice(0, diff);
        session.session.messageCount = this.options.maxMessages;
      } else {
        session.session.messageCount = session.messages.length;
      }

      session.session.updatedAt = new Date();

      return storedMessages;
    });

    this.applyWriteHooks(sessionId, value.length, durationMs);
    return value;
  }

  async loadContext(sessionId: string, opts?: MemoryContextRequest): Promise<MemoryContext> {
    const stored = this.sessions.get(sessionId);
    if (!stored) {
      return { sessionId, messages: [], summary: undefined, totalMessages: 0, omittedMessages: 0 };
    }
    this.ensureNotExpired(sessionId, stored.session);
    if (!this.sessions.has(sessionId)) {
      return { sessionId, messages: [], summary: undefined, totalMessages: 0, omittedMessages: 0 };
    }

    const { durationMs, value } = await time(() =>
      computeContext(sessionId, stored.messages, opts, {
        maxMessages: this.options.maxMessages,
        contextWindowTokens: this.options.contextWindowTokens,
        compressor: this.options.compressor,
        tokenizer: this.options.tokenizer
      })
    );

    this.applyReadHooks(sessionId, value.messages.length, opts?.strategy, durationMs);

    return {
      ...value,
      metadata: opts?.includeMetadata ? stored.session.metadata : undefined,
      expiresAt: stored.session.expiresAt
    };
  }

  async listSessions(filter?: SessionFilter): Promise<MemorySession[]> {
    const sessions: MemorySession[] = [];
    for (const [sessionId, stored] of this.sessions.entries()) {
      this.ensureNotExpired(sessionId, stored.session);
      if (!this.sessions.has(sessionId)) continue;
      const { session } = stored;
      if (filter?.userId && session.userId !== filter.userId) continue;
      if (filter?.before && session.updatedAt >= filter.before) continue;
      if (filter?.after && session.updatedAt <= filter.after) continue;
      sessions.push(toMemorySession(sessionId, session));
    }
    sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return sessions;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const existing = this.sessions.get(sessionId);
    if (!existing) return;
    this.sessions.delete(sessionId);
    this.applyDeleteHooks(sessionId, existing.messages.length);
  }

  async deleteMessages(sessionId: string, predicate: (message: MemoryMessage) => boolean): Promise<number> {
    const stored = this.sessions.get(sessionId);
    if (!stored) return 0;
    const before = stored.messages.length;
    stored.messages = stored.messages.filter((msg) => !predicate(msg));
    stored.session.messageCount = stored.messages.length;
    stored.session.updatedAt = new Date();
    const deleted = before - stored.messages.length;
    if (deleted > 0) {
      this.applyDeleteHooks(sessionId, deleted);
    }
    return deleted;
  }

  async touchSession(sessionId: string, ttlSeconds?: number): Promise<void> {
    const stored = this.sessions.get(sessionId);
    if (!stored) return;
    stored.session.updatedAt = new Date();
    if (ttlSeconds ?? this.options.defaultTTLSeconds) {
      const ttl = ttlSeconds ?? this.options.defaultTTLSeconds;
      stored.session.expiresAt = new Date(Date.now() + ttl * 1000);
    }
  }

  async pruneExpired(): Promise<number> {
    let removed = 0;
    const now = Date.now();
    for (const [sessionId, stored] of [...this.sessions.entries()]) {
      const expiresAt = stored.session.expiresAt;
      if (expiresAt && expiresAt.getTime() <= now) {
        this.sessions.delete(sessionId);
        removed += 1;
        this.applyDeleteHooks(sessionId, stored.messages.length);
      }
    }
    return removed;
  }

  async stats(): Promise<MemoryStats> {
    let messages = 0;
    for (const stored of this.sessions.values()) {
      messages += stored.messages.length;
    }
    return {
      sessions: this.sessions.size,
      messages,
      expiredSessions: 0
    };
  }

  async close(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }
}

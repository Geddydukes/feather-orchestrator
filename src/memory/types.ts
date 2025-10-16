export type MemoryMessageRole = "system" | "user" | "assistant" | "tool";

export interface MemoryMessage {
  id: string;
  sessionId: string;
  role: MemoryMessageRole;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  tokens?: number;
  sequence?: number;
}

export interface MemoryMessageInput {
  role: MemoryMessageRole;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
  tokens?: number;
}

export interface MemorySession {
  sessionId: string;
  userId?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date | null;
  messageCount: number;
}

export interface MemoryContext {
  sessionId: string;
  messages: MemoryMessage[];
  summary?: string;
  totalMessages: number;
  omittedMessages: number;
  expiresAt?: Date | null;
  metadata?: Record<string, unknown>;
}

export type MemoryContextStrategy = "none" | "truncate" | "summarize" | "hybrid";

export interface MemoryContextRequest {
  limit?: number;
  maxTokens?: number;
  strategy?: MemoryContextStrategy;
  since?: Date;
  timeWindowMs?: number;
  includeMetadata?: boolean;
  attachSummaryAsSystemMessage?: boolean;
}

export interface MemoryWriteOptions {
  ttlSeconds?: number;
  metadata?: Record<string, unknown>;
  userId?: string;
}

export interface MemoryDeleteOptions {
  hard?: boolean;
}

export interface MemoryStats {
  sessions: number;
  messages: number;
  expiredSessions: number;
  storageBytes?: number;
}

export interface MemoryManagerHooks {
  onRead?(event: { sessionId: string; messages: number; strategy: MemoryContextStrategy; durationMs: number }): void;
  onWrite?(event: { sessionId: string; messages: number; durationMs: number }): void;
  onDelete?(event: { sessionId: string; messages: number }): void;
}

export interface TokenCounter {
  (messages: Array<Pick<MemoryMessage, "role" | "content">>): number;
}

export interface MemoryCompressorResult {
  summary: string;
  tokens: number;
}

export interface MemoryCompressor {
  summarize(messages: MemoryMessage[], opts: MemoryContextRequest & { maxTokens: number }): Promise<MemoryCompressorResult> | MemoryCompressorResult;
}

export interface BaseMemoryOptions {
  maxMessages?: number;
  defaultTTLSeconds?: number;
  maxSessions?: number;
  contextWindowTokens?: number;
  compressor?: MemoryCompressor;
  tokenizer?: TokenCounter;
  hooks?: MemoryManagerHooks;
}

export type SessionFilter = {
  userId?: string;
  before?: Date;
  after?: Date;
};

export interface MemoryManager {
  appendMessages(sessionId: string, messages: MemoryMessageInput[], opts?: MemoryWriteOptions): Promise<MemoryMessage[]>;
  loadContext(sessionId: string, opts?: MemoryContextRequest): Promise<MemoryContext>;
  listSessions(filter?: SessionFilter): Promise<MemorySession[]>;
  deleteSession(sessionId: string, opts?: MemoryDeleteOptions): Promise<void>;
  deleteMessages(sessionId: string, predicate: (message: MemoryMessage) => boolean): Promise<number>;
  touchSession(sessionId: string, ttlSeconds?: number): Promise<void>;
  pruneExpired(): Promise<number>;
  stats(): Promise<MemoryStats>;
  close(): Promise<void>;
}

export interface MemoryManagerFactory<TOptions = unknown> {
  create(options: TOptions): Promise<MemoryManager> | MemoryManager;
}

import { performance } from "node:perf_hooks";
import {
  type BaseMemoryOptions,
  type MemoryCompressor,
  type MemoryContext,
  type MemoryContextRequest,
  type MemoryMessage,
  type MemoryMessageInput,
  type MemoryMessageRole,
  type MemorySession,
  type TokenCounter
} from "./types.js";

export const DEFAULT_MAX_MESSAGES = 200;
export const DEFAULT_CONTEXT_TOKENS = 3000;

const DEFAULT_TOKEN_ESTIMATE = 4; // ~4 characters per token heuristic

export const defaultTokenizer: TokenCounter = (messages) =>
  messages.reduce((acc, msg) => acc + Math.ceil(msg.content.length / DEFAULT_TOKEN_ESTIMATE), 0);

export const cloneMessage = (message: MemoryMessage): MemoryMessage => ({
  ...message,
  metadata: message.metadata ? { ...message.metadata } : undefined,
  createdAt: new Date(message.createdAt)
});

export const realizeMessage = (
  sessionId: string,
  input: MemoryMessageInput,
  nextSequence: number,
  tokenizer: TokenCounter = defaultTokenizer
): MemoryMessage => {
  const createdAt = input.createdAt ?? new Date();
  const tokens = input.tokens ?? tokenizer([{ role: input.role, content: input.content }]);
  return {
    id: crypto.randomUUID(),
    sessionId,
    role: input.role,
    content: input.content,
    metadata: input.metadata ? { ...input.metadata } : undefined,
    createdAt,
    tokens,
    sequence: nextSequence
  };
};

export interface ContextComputationOptions extends MemoryContextRequest {
  maxMessages?: number;
  contextWindowTokens?: number;
  compressor?: MemoryCompressor;
  tokenizer?: TokenCounter;
}

export interface ContextComputationResult {
  messages: MemoryMessage[];
  summary?: string;
  omittedMessages: number;
}

export const computeContext = async (
  sessionId: string,
  source: MemoryMessage[],
  request: MemoryContextRequest | undefined,
  options: ContextComputationOptions
): Promise<MemoryContext> => {
  const strategy = request?.strategy ?? "hybrid";
  const limit = request?.limit ?? options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxTokens = request?.maxTokens ?? options.contextWindowTokens ?? DEFAULT_CONTEXT_TOKENS;
  const since = request?.since?.getTime();
  const windowMs = request?.timeWindowMs;
  const now = Date.now();

  let filtered = source.slice();
  if (since) {
    filtered = filtered.filter((msg) => msg.createdAt.getTime() >= since);
  }
  if (windowMs !== undefined) {
    const threshold = now - windowMs;
    filtered = filtered.filter((msg) => msg.createdAt.getTime() >= threshold);
  }

  const totalMessages = filtered.length;

  if (totalMessages === 0) {
    return {
      sessionId,
      messages: [],
      summary: undefined,
      totalMessages: 0,
      omittedMessages: 0
    };
  }

  const tokenizer = options.tokenizer ?? defaultTokenizer;

  const applyTruncation = (): { kept: MemoryMessage[]; omitted: number } => {
    let tokens = 0;
    const kept: MemoryMessage[] = [];
    for (let i = filtered.length - 1; i >= 0; i -= 1) {
      const candidate = filtered[i];
      const count = candidate.tokens ?? tokenizer([{ role: candidate.role, content: candidate.content }]);
      if (tokens + count > maxTokens) {
        break;
      }
      tokens += count;
      kept.push(candidate);
      if (kept.length >= limit) {
        break;
      }
    }
    kept.reverse();
    return { kept, omitted: filtered.length - kept.length };
  };

  const truncated = applyTruncation();

  if (strategy === "none") {
    const sliced = filtered.slice(-limit);
    return {
      sessionId,
      messages: sliced,
      summary: undefined,
      totalMessages,
      omittedMessages: totalMessages - sliced.length
    };
  }

  if (strategy === "truncate") {
    return {
      sessionId,
      messages: truncated.kept,
      summary: undefined,
      totalMessages,
      omittedMessages: truncated.omitted
    };
  }

  if ((strategy === "summarize" || strategy === "hybrid") && truncated.omitted > 0) {
    const compressor = options.compressor;
    if (!compressor) {
      return {
        sessionId,
        messages: truncated.kept,
        summary: undefined,
        totalMessages,
        omittedMessages: truncated.omitted
      };
    }
    const summaryResult = await compressor.summarize(filtered.slice(0, truncated.omitted), {
      ...request,
      maxTokens
    });
    return {
      sessionId,
      messages: truncated.kept,
      summary: summaryResult.summary,
      totalMessages,
      omittedMessages: truncated.omitted
    };
  }

  return {
    sessionId,
    messages: truncated.kept,
    summary: undefined,
    totalMessages,
    omittedMessages: truncated.omitted
  };
};

export const defaultSummary = (messages: MemoryMessage[]): string => {
  const snippet = messages
    .slice(-5)
    .map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`)
    .join("\n");
  return snippet.slice(0, 1000);
};

export class SimpleConcatenatingCompressor implements MemoryCompressor {
  constructor(private tokenizer: TokenCounter = defaultTokenizer) {}

  summarize(messages: MemoryMessage[], opts: MemoryContextRequest & { maxTokens: number }) {
    if (messages.length === 0) {
      return { summary: "", tokens: 0 };
    }
    const joined = messages.map((m) => `${m.role}: ${m.content}`).join(" \n");
    const tokens = Math.min(opts.maxTokens, Math.ceil(joined.length / DEFAULT_TOKEN_ESTIMATE));
    const trimmed = joined.length > opts.maxTokens * DEFAULT_TOKEN_ESTIMATE
      ? `${joined.slice(0, opts.maxTokens * DEFAULT_TOKEN_ESTIMATE)}…`
      : joined;
    return { summary: trimmed, tokens };
  }
}

export const time = async <T>(fn: () => Promise<T> | T): Promise<{ durationMs: number; value: T }> => {
  const start = performance.now();
  const value = await fn();
  const durationMs = performance.now() - start;
  return { durationMs, value };
};

export const toMemorySession = (
  sessionId: string,
  record: {
    userId?: string;
    metadata?: Record<string, unknown>;
    createdAt: Date;
    updatedAt: Date;
    expiresAt?: Date | null;
    messageCount: number;
  }
): MemorySession => ({
  sessionId,
  userId: record.userId,
  metadata: record.metadata,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  expiresAt: record.expiresAt,
  messageCount: record.messageCount
});

export const filterMetadata = <T extends { metadata?: Record<string, unknown> }>(
  value: T,
  include: boolean | undefined
): T => {
  if (include === false) {
    const clone: T = { ...value };
    if (clone.metadata) {
      clone.metadata = undefined;
    }
    return clone;
  }
  return value;
};

export const ensureRole = (role: MemoryMessageRole): MemoryMessageRole => role;

export type MessageStoreRecord = {
  sessionId: string;
  message: MemoryMessage;
};

export const serializeMessage = (message: MemoryMessage): Record<string, unknown> => ({
  ...message,
  createdAt: message.createdAt.toISOString()
});

export const deserializeMessage = (record: any): MemoryMessage => ({
  id: record.id,
  sessionId: record.sessionId,
  role: record.role,
  content: record.content,
  metadata: record.metadata ?? undefined,
  createdAt: new Date(record.createdAt),
  tokens: record.tokens ?? undefined,
  sequence: record.sequence ?? undefined
});

export const toJson = (value: unknown): string => JSON.stringify(value);
export const fromJson = <T>(value: string | null): T | undefined => (value ? (JSON.parse(value) as T) : undefined);

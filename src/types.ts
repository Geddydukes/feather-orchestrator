export type Role = "system" | "user" | "assistant" | "tool";

export interface Message { role: Role; content: string }

export interface ChatRequest {
  model: string;
  messages: Message[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

export interface ChatDelta { content?: string }
export interface ChatResponse {
  content: string;
  raw?: any;
  tokens?: { input?: number; output?: number };
  costUSD?: number;
}

export interface CallOpts {
  timeoutMs?: number;
  retry?: { maxAttempts?: number; baseMs?: number; maxMs?: number; jitter?: "none"|"full" };
}

export interface TokenEstimate { input: number; output?: number }
export interface PriceTable { inputPer1K?: number; outputPer1K?: number }

export interface MiddlewareContext {
  provider: string;
  model: string;
  request: ChatRequest;
  response?: ChatResponse;
  error?: unknown;
  startTs: number;
  endTs?: number;
}

export type Middleware = (ctx: MiddlewareContext, next: () => Promise<void>) => Promise<void>;

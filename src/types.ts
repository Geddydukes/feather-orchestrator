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
  signal?: AbortSignal;
  retry?: RetryOpts;
}

export interface RetryOpts {
  maxAttempts?: number;
  baseMs?: number;
  maxMs?: number;
  jitter?: "none" | "full";
  signal?: AbortSignal;
  maxTotalMs?: number;
  onRetry?: (info: { attempt: number; waitMs: number; error: unknown }) => void;
  statusRetry?: (status: number) => boolean;
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

export type Middleware = (ctx: MiddlewareContext, next: () => Promise<any>) => Promise<void>;

// Enhanced error types
export class LLMError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly status?: number,
    public readonly requestId?: string,
    public readonly retryable: boolean = true,
    public readonly retryAfter?: number
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

// Event types for observability
export type FeatherEvent =
  | { type: "call.start"; provider: string; model: string; requestId?: string }
  | { type: "call.success"; provider: string; model: string; costUSD?: number; requestId?: string }
  | { type: "call.error"; provider: string; model: string; error: unknown; requestId?: string }
  | { type: "call.retry"; attempt: number; waitMs: number; error: unknown; requestId?: string }
  | { type: "rate.wait"; key: string; waitMs: number }
  | { type: "breaker.open"; provider: string }
  | { type: "breaker.close"; provider: string };

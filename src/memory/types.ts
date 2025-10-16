export type MemoryRole = "system" | "user" | "assistant" | "tool" | "summary";

export interface MemoryTurn {
  role: MemoryRole;
  content: unknown;
  createdAt?: Date;
  tokens?: number;
}

export interface MemoryGetContextOptions {
  /** Maximum number of tokens allowed when constructing the context window. */
  maxTokens?: number;
  /** Maximum number of turns to return regardless of token budget. */
  maxTurns?: number;
}

export interface MemoryTrimOptions {
  /** Optional hard limit on stored turns after trimming. */
  retainTurns?: number;
}

export interface MemoryManager<TTurn extends MemoryTurn = MemoryTurn> {
  append(sessionId: string, turn: TTurn): Promise<void>;
  getContext(sessionId: string, options?: MemoryGetContextOptions): Promise<TTurn[]>;
  summarize?(sessionId: string): Promise<void>;
  trim?(sessionId: string, options?: MemoryTrimOptions): Promise<void>;
}

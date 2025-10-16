import { defaultTokenCounter, type TokenCounter } from "./tokenizer.js";
import type {
  MemoryGetContextOptions,
  MemoryManager,
  MemoryRole,
  MemoryTrimOptions,
  MemoryTurn,
} from "./types.js";

export interface InMemoryMemoryManagerOptions {
  /**
   * Maximum number of turns to retain in storage. Older turns are removed on append once this limit
   * is exceeded. Defaults to unlimited retention.
   */
  maxTurns?: number;
  /**
   * Token counter used to calculate message budgets. Defaults to a lightweight whitespace-based
   * implementation so we do not require native dependencies.
   */
  tokenCounter?: TokenCounter;
  /**
   * Number of most recent turns to preserve verbatim when summarizing. Older turns are condensed
   * into a single summary turn.
   */
  summaryMaxRecentTurns?: number;
  /**
   * Role assigned to generated summary turns.
   */
  summaryRole?: MemoryRole;
  /**
   * Custom summariser. Receives the turns being condensed and returns content for the summary turn.
   */
  summarizer?: (turns: MemoryTurn[]) => unknown;
}

const DEFAULT_SUMMARY_RECENT_TURNS = 4;
const DEFAULT_SUMMARY_ROLE: MemoryRole = "summary";

type SessionTurns = MemoryTurn[];

function cloneTurn(turn: MemoryTurn): MemoryTurn {
  return {
    ...turn,
    createdAt: turn.createdAt ? new Date(turn.createdAt) : undefined,
    tokens: turn.tokens,
  };
}

export class InMemoryMemoryManager implements MemoryManager {
  private readonly sessions = new Map<string, SessionTurns>();
  private readonly tokenCounter: TokenCounter;
  private readonly maxTurns?: number;
  private readonly summaryMaxRecentTurns: number;
  private readonly summaryRole: MemoryRole;
  private readonly summarizer?: (turns: MemoryTurn[]) => unknown;

  constructor(options: InMemoryMemoryManagerOptions = {}) {
    this.maxTurns = options.maxTurns;
    this.summaryMaxRecentTurns = options.summaryMaxRecentTurns ?? DEFAULT_SUMMARY_RECENT_TURNS;
    this.summaryRole = options.summaryRole ?? DEFAULT_SUMMARY_ROLE;
    this.summarizer = options.summarizer;
    this.tokenCounter = options.tokenCounter ?? defaultTokenCounter;
  }

  async append(sessionId: string, turn: MemoryTurn): Promise<void> {
    const turns = this.sessions.get(sessionId) ?? [];
    const normalised = this.withTokenMetadata(turn);
    turns.push(normalised);
    this.sessions.set(sessionId, turns);
    if (this.maxTurns && turns.length > this.maxTurns) {
      turns.splice(0, turns.length - this.maxTurns);
    }
  }

  async getContext(sessionId: string, options: MemoryGetContextOptions = {}): Promise<MemoryTurn[]> {
    const storedTurns = this.sessions.get(sessionId);
    if (!storedTurns || storedTurns.length === 0) {
      return [];
    }

    const turns = this.applyMaxTurnsOption(storedTurns, options.maxTurns);
    if (options.maxTokens == null) {
      return turns.map(cloneTurn);
    }

    const result: MemoryTurn[] = [];
    let remainingTokens = options.maxTokens;

    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const current = turns[index];
      const turn = this.withTokenMetadata(current);
      const tokens = turn.tokens ?? 0;

      if (tokens > remainingTokens) {
        const truncated = this.truncateTurnToBudget(turn, remainingTokens);
        if (truncated) {
          result.unshift(truncated);
        }
        break;
      }

      result.unshift(cloneTurn(turn));
      remainingTokens -= tokens;
      if (remainingTokens <= 0) {
        break;
      }
    }

    return result;
  }

  async summarize(sessionId: string): Promise<void> {
    const turns = this.sessions.get(sessionId);
    if (!turns || turns.length === 0) {
      return;
    }

    if (turns.length <= this.summaryMaxRecentTurns) {
      return;
    }

    const cutoff = Math.max(0, turns.length - this.summaryMaxRecentTurns);
    const historicTurns = turns.slice(0, cutoff).map(cloneTurn);
    const recentTurns = turns.slice(cutoff);

    if (historicTurns.length === 0) {
      return;
    }

    const summaryContent = this.summarizer
      ? this.summarizer(historicTurns)
      : this.defaultSummarize(historicTurns);

    const summaryTurn = this.withTokenMetadata({
      role: this.summaryRole,
      content: summaryContent,
      createdAt: new Date(),
    });

    this.sessions.set(sessionId, [summaryTurn, ...recentTurns.map(cloneTurn)]);
  }

  async trim(sessionId: string, options: MemoryTrimOptions = {}): Promise<void> {
    const turns = this.sessions.get(sessionId);
    if (!turns || turns.length === 0) {
      return;
    }

    const retainTurns = options.retainTurns ?? this.maxTurns;
    if (!retainTurns || retainTurns <= 0) {
      this.sessions.delete(sessionId);
      return;
    }

    if (turns.length <= retainTurns) {
      return;
    }

    const trimmed = turns.slice(-retainTurns).map(cloneTurn);
    this.sessions.set(sessionId, trimmed);
  }

  private applyMaxTurnsOption(turns: SessionTurns, maxTurns?: number): MemoryTurn[] {
    if (!maxTurns || maxTurns >= turns.length) {
      return turns.map(cloneTurn);
    }

    return turns.slice(-maxTurns).map(cloneTurn);
  }

  private defaultSummarize(turns: MemoryTurn[]): string {
    return turns
      .map((turn) => {
        const created = turn.createdAt ? `@${turn.createdAt.toISOString()}` : "";
        return `[${turn.role}${created}] ${this.stringifyContent(turn.content)}`;
      })
      .join("\n");
  }

  private stringifyContent(content: unknown): string {
    if (content == null) {
      return "";
    }

    if (typeof content === "string") {
      return content;
    }

    try {
      return JSON.stringify(content);
    } catch (error) {
      return String(content);
    }
  }

  private withTokenMetadata(turn: MemoryTurn): MemoryTurn {
    const existing = turn.tokens;
    if (existing != null) {
      return { ...turn, tokens: existing };
    }

    const tokens = this.tokenCounter.count(turn.content);
    return {
      ...turn,
      tokens,
      createdAt: turn.createdAt ?? new Date(),
    };
  }

  private truncateTurnToBudget(turn: MemoryTurn, budget: number): MemoryTurn | undefined {
    if (budget <= 0) {
      return undefined;
    }

    const content = turn.content;
    if (typeof content !== "string") {
      return undefined;
    }

    const tokens = this.tokenCounter.count(content);
    if (tokens <= budget) {
      return cloneTurn(turn);
    }

    const words = content.trim().split(/\s+/u);
    if (words.length === 0) {
      return undefined;
    }

    const truncatedWords = words.slice(0, budget);
    const truncatedContent = truncatedWords.join(" ");
    const finalContent = truncatedWords.length < words.length ? `${truncatedContent} …` : truncatedContent;

    return {
      ...turn,
      content: finalContent,
      tokens: Math.min(budget, this.tokenCounter.count(finalContent)),
    };
  }
}

import { defaultTokenCounter, type TokenCounter } from "../memory/tokenizer.js";
import type {
  AgentMemoryTurn,
  AgentMessage,
  AgentMessageRole,
  AgentSystemMessage,
  AgentToolMessage
} from "./types.js";

export interface ContextDigest {
  content: string;
  label?: string;
  role?: DigestRole;
}

export interface ContextBuilderOptions {
  tokenCounter?: TokenCounter;
  maxRecentTurns?: number;
  digestRole?: DigestRole;
}

export interface ContextBuildOptions {
  history?: readonly AgentMemoryTurn[];
  baseMessages?: readonly AgentMessage[];
  ragMessages?: readonly AgentMessage[];
  digests?: readonly ContextDigest[];
  maxTokens: number;
  maxRecentTurns?: number;
}

interface TokenisedMessage {
  message: AgentMessage;
  tokens: number;
}

const DEFAULT_MAX_RECENT_TURNS = 8;
type DigestRole = Exclude<AgentMessageRole, "tool">;

const DEFAULT_DIGEST_ROLE: DigestRole = "system";

export class ContextBuilder {
  private readonly tokenCounter: TokenCounter;
  private readonly maxRecentTurns: number;
  private readonly digestRole: DigestRole;

  constructor(options: ContextBuilderOptions = {}) {
    this.tokenCounter = options.tokenCounter ?? defaultTokenCounter;
    this.maxRecentTurns = options.maxRecentTurns ?? DEFAULT_MAX_RECENT_TURNS;
    this.digestRole = options.digestRole ?? DEFAULT_DIGEST_ROLE;
  }

  build(options: ContextBuildOptions): AgentMessage[] {
    if (!options) {
      throw new Error("Context build options are required");
    }
    if (!Number.isFinite(options.maxTokens) || options.maxTokens <= 0) {
      throw new Error("ContextBuilder requires a positive maxTokens budget");
    }

    const baseMessages = this.cloneMessages(options.baseMessages ?? []);
    const historyMessages = this.extractHistoryMessages(options.history ?? []);
    const recentLimit = options.maxRecentTurns ?? this.maxRecentTurns;
    const recentMessages = recentLimit > 0 ? historyMessages.slice(-recentLimit) : historyMessages.slice();
    const olderMessages = historyMessages.slice(0, historyMessages.length - recentMessages.length);

    const digestMessages = this.createDigestMessages(options.digests, olderMessages);
    const ragMessages = this.cloneMessages(options.ragMessages ?? []);

    const sections = {
      base: this.tokenise(baseMessages),
      digest: this.tokenise(digestMessages),
      rag: this.tokenise(ragMessages),
      recent: this.tokenise(recentMessages)
    } as const;

    let totalTokens = this.calculateTotalTokens(sections);
    const budget = options.maxTokens;

    totalTokens = this.enforceBudget(sections, totalTokens, budget);

    const ordered = [
      ...sections.base,
      ...sections.digest,
      ...sections.rag,
      ...sections.recent
    ];

    if (totalTokens > budget) {
      throw new Error(`ContextBuilder failed to satisfy token budget of ${budget}`);
    }

    return ordered.map((entry) => entry.message);
  }

  private cloneMessages(messages: readonly AgentMessage[]): AgentMessage[] {
    return messages.map((message) => ({ ...message }));
  }

  private extractHistoryMessages(turns: readonly AgentMemoryTurn[]): AgentMessage[] {
    const result: AgentMessage[] = [];
    for (const turn of turns) {
      const message = this.fromTurn(turn);
      if (message) {
        result.push(message);
      }
    }
    return result;
  }

  private fromTurn(turn: AgentMemoryTurn): AgentMessage | undefined {
    const content = turn.content;
    if (isAgentMessage(content)) {
      return { ...content };
    }

    if (turn.role === "summary") {
      const text = this.stringifyContent(content);
      if (text.length === 0) {
        return undefined;
      }
      return this.makeTextMessage(this.digestRole, text);
    }

    if (turn.role === "tool") {
      // Tool observations must include a name field, so we only surface entries that are
      // already shaped as AgentMessages.
      return undefined;
    }

    const text = this.stringifyContent(content);
    if (text.length === 0) {
      return undefined;
    }

    return this.makeTextMessage(mapMemoryRole(turn.role), text);
  }

  private createDigestMessages(
    digests: readonly ContextDigest[] | undefined,
    historicMessages: AgentMessage[]
  ): AgentMessage[] {
    const configuredDigests = (digests ?? []).map((digest) =>
      this.makeTextMessage(
        digest.role ?? this.digestRole,
        digest.label ? `${digest.label}: ${digest.content}` : digest.content
      )
    );

    if (configuredDigests.length > 0) {
      return configuredDigests;
    }

    if (historicMessages.length === 0) {
      return [];
    }

    const summary = historicMessages
      .map((message) => this.describeMessage(message))
      .join("\n");

    return [this.makeTextMessage(this.digestRole, summary)];
  }

  private describeMessage(message: AgentMessage): string {
    if (message.role === "tool") {
      return `[tool:${message.name}] ${this.stringifyContent((message as AgentToolMessage).content)}`;
    }

    const text = this.stringifyContent(message.content);
    return `[${message.role}] ${text}`;
  }

  private makeTextMessage(role: DigestRole, content: string): AgentMessage {
    if (role === "assistant") {
      return { role: "assistant", content };
    }
    if (role === "user") {
      return { role: "user", content };
    }
    return { role: "system", content } satisfies AgentSystemMessage;
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

  private tokenise(messages: AgentMessage[]): TokenisedMessage[] {
    return messages.map((message) => ({
      message,
      tokens: this.countTokens(message)
    }));
  }

  private countTokens(message: AgentMessage): number {
    if (message.role === "tool") {
      return this.tokenCounter.count({ name: message.name, content: message.content });
    }
    return this.tokenCounter.count(message.content);
  }

  private calculateTotalTokens(sections: Record<string, readonly TokenisedMessage[]>): number {
    let total = 0;
    for (const entries of Object.values(sections)) {
      for (const entry of entries) {
        total += entry.tokens;
      }
    }
    return total;
  }

  private enforceBudget(
    sections: {
      base: TokenisedMessage[];
      digest: TokenisedMessage[];
      rag: TokenisedMessage[];
      recent: TokenisedMessage[];
    },
    totalTokens: number,
    budget: number
  ): number {
    while (totalTokens > budget) {
      if (sections.rag.length > 0) {
        const removed = sections.rag.pop();
        if (removed) {
          totalTokens -= removed.tokens;
          continue;
        }
      }

      if (sections.digest.length > 0) {
        const digest = sections.digest[0];
        const allowed = budget - (totalTokens - digest.tokens);
        const truncated = this.truncateMessage(digest.message, allowed);
        if (!truncated) {
          const removed = sections.digest.shift();
          if (removed) {
            totalTokens -= removed.tokens;
            continue;
          }
        } else {
          const newEntry = { message: truncated, tokens: this.countTokens(truncated) };
          sections.digest[0] = newEntry;
          totalTokens = totalTokens - digest.tokens + newEntry.tokens;
          if (totalTokens <= budget) {
            break;
          }
          continue;
        }
      }

      if (sections.recent.length > 0) {
        const removed = sections.recent.shift();
        if (removed) {
          totalTokens -= removed.tokens;
          continue;
        }
      }

      const base = sections.base[sections.base.length - 1];
      if (base) {
        const allowed = budget - (totalTokens - base.tokens);
        const truncated = this.truncateMessage(base.message, allowed);
        if (truncated) {
          const newEntry = { message: truncated, tokens: this.countTokens(truncated) };
          sections.base[sections.base.length - 1] = newEntry;
          totalTokens = totalTokens - base.tokens + newEntry.tokens;
          if (totalTokens <= budget) {
            break;
          }
          continue;
        }
      }

      break;
    }

    return totalTokens;
  }

  private truncateMessage(message: AgentMessage, budget: number): AgentMessage | undefined {
    if (budget <= 0) {
      return undefined;
    }
    if (message.role === "tool") {
      return undefined;
    }
    if (typeof message.content !== "string") {
      return undefined;
    }

    const words = message.content.trim().split(/\s+/u);
    if (words.length === 0) {
      return undefined;
    }

    if (words.length <= budget) {
      return { ...message };
    }

    const needsEllipsis = words.length > budget;
    const wordBudget = needsEllipsis && budget > 1 ? budget - 1 : budget;
    const truncatedWords = words.slice(0, wordBudget);
    const truncatedContent = truncatedWords.join(" ");

    let finalContent = truncatedContent;
    if (needsEllipsis && budget > 1) {
      finalContent = `${truncatedContent} …`;
    }

    return {
      ...message,
      content: finalContent.trim()
    };
  }
}

function mapMemoryRole(role: AgentMessageRole | "summary"): DigestRole {
  if (role === "summary" || role === "system") {
    return "system";
  }
  if (role === "assistant" || role === "user") {
    return role;
  }
  return "system";
}

function isAgentMessage(value: unknown): value is AgentMessage {
  return Boolean(
    value &&
      typeof value === "object" &&
      "role" in value &&
      typeof (value as { role?: unknown }).role === "string"
  );
}

import type {
  MemoryGetContextOptions,
  MemoryManager,
  MemoryRole,
  MemoryTrimOptions,
  MemoryTurn
} from "./types.js";
import { defaultTokenCounter, type TokenCounter } from "./tokenizer.js";

export interface RedisClientLike {
  rPush(key: string, value: string): Promise<number>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  lTrim(key: string, start: number, stop: number): Promise<unknown>;
  lLen(key: string): Promise<number>;
  expire?(key: string, ttlSeconds: number): Promise<number>;
  del?(key: string): Promise<number>;
  multi?(): RedisMultiLike;
  eval?(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  evalSha?(sha: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  scriptLoad?(script: string): Promise<string>;
}

export interface RedisMultiLike {
  rPush(key: string, value: string): RedisMultiLike;
  lTrim(key: string, start: number, stop: number): RedisMultiLike;
  expire?(key: string, ttlSeconds: number): RedisMultiLike;
  del?(key: string): RedisMultiLike;
  exec(): Promise<unknown>;
}

export interface RedisMemoryManagerOptions {
  client: RedisClientLike;
  namespace?: string;
  maxTurns?: number;
  ttlSeconds?: number;
  tokenCounter?: TokenCounter;
  summaryMaxRecentTurns?: number;
  summaryRole?: MemoryRole;
  summarizer?: (turns: MemoryTurn[]) => unknown;
}

const APPEND_AND_TRIM_SCRIPT = `
local key = KEYS[1]
local payload = ARGV[1]
local maxTurns = tonumber(ARGV[2]) or 0
local ttlSeconds = tonumber(ARGV[3]) or 0
local length = redis.call('RPUSH', key, payload)
if maxTurns > 0 and length > maxTurns then
  local startIndex = length - maxTurns
  if startIndex < 0 then
    startIndex = 0
  end
  redis.call('LTRIM', key, startIndex, -1)
end
if ttlSeconds > 0 then
  redis.call('EXPIRE', key, ttlSeconds)
end
return length
`;

export class RedisMemoryManager implements MemoryManager {
  private readonly client: RedisClientLike;
  private readonly namespace?: string;
  private readonly maxTurns?: number;
  private readonly ttlSeconds?: number;
  private readonly tokenCounter: TokenCounter;
  private readonly summaryMaxRecentTurns: number;
  private readonly summaryRole: MemoryRole;
  private readonly summarizer?: (turns: MemoryTurn[]) => unknown;
  private appendScriptSha?: string;

  constructor(options: RedisMemoryManagerOptions) {
    if (!options || !options.client) {
      throw new Error("RedisMemoryManager requires a Redis client");
    }

    this.client = options.client;
    this.namespace = options.namespace;
    this.maxTurns = options.maxTurns;
    this.ttlSeconds = options.ttlSeconds;
    this.tokenCounter = options.tokenCounter ?? defaultTokenCounter;
    this.summaryMaxRecentTurns = options.summaryMaxRecentTurns ?? 4;
    this.summaryRole = options.summaryRole ?? "summary";
    this.summarizer = options.summarizer;
  }

  async append(sessionId: string, turn: MemoryTurn): Promise<void> {
    const key = this.getSessionKey(sessionId);
    const normalised = this.withTokenMetadata(turn);
    const payload = JSON.stringify(this.serialiseTurn(normalised));
    await this.executeAppendScript(key, payload);
  }

  async getContext(sessionId: string, options: MemoryGetContextOptions = {}): Promise<MemoryTurn[]> {
    const key = this.getSessionKey(sessionId);
    const maxTurns = options.maxTurns ?? undefined;

    let entries: string[];
    if (maxTurns && maxTurns > 0) {
      entries = await this.client.lRange(key, -maxTurns, -1);
    } else {
      entries = await this.client.lRange(key, 0, -1);
    }

    if (!entries || entries.length === 0) {
      return [];
    }

    const turns = entries.map((entry) => this.deserialiseTurn(entry));
    if (options.maxTokens == null) {
      return turns.map((turn) => this.cloneTurn(turn));
    }

    const result: MemoryTurn[] = [];
    let remainingTokens = options.maxTokens;

    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const current = this.withTokenMetadata(turns[index]);
      const tokens = current.tokens ?? 0;

      if (tokens > remainingTokens) {
        const truncated = this.truncateTurnToBudget(current, remainingTokens);
        if (truncated) {
          result.unshift(truncated);
        }
        break;
      }

      result.unshift(this.cloneTurn(current));
      remainingTokens -= tokens;
      if (remainingTokens <= 0) {
        break;
      }
    }

    return result;
  }

  async summarize(sessionId: string): Promise<void> {
    const key = this.getSessionKey(sessionId);
    const entries = await this.client.lRange(key, 0, -1);
    if (!entries || entries.length === 0) {
      return;
    }

    if (entries.length <= this.summaryMaxRecentTurns) {
      return;
    }

    const turns = entries.map((entry) => this.deserialiseTurn(entry));
    const cutoff = Math.max(0, turns.length - this.summaryMaxRecentTurns);
    const historic = turns.slice(0, cutoff).map((turn) => this.cloneTurn(turn));
    if (historic.length === 0) {
      return;
    }

    const recent = turns.slice(cutoff);
    const summaryContent = this.summarizer
      ? this.summarizer(historic)
      : this.defaultSummarize(historic);

    const summaryTurn = this.withTokenMetadata({
      role: this.summaryRole,
      content: summaryContent,
      createdAt: new Date(),
    });

    const serialised = [
      JSON.stringify(this.serialiseTurn(summaryTurn)),
      ...recent.map((turn) => JSON.stringify(this.serialiseTurn(turn)))
    ];

    await this.replaceSession(key, serialised);
  }

  async trim(sessionId: string, options: MemoryTrimOptions = {}): Promise<void> {
    const key = this.getSessionKey(sessionId);
    const retainTurns = options.retainTurns ?? this.maxTurns;

    if (!retainTurns || retainTurns <= 0) {
      if (this.client.del) {
        await this.client.del(key);
      } else {
        await this.client.lTrim(key, 1, 0);
      }
      return;
    }

    await this.client.lTrim(key, -retainTurns, -1);
    await this.ensureTtl(key);
  }

  private async executeAppendScript(key: string, payload: string): Promise<void> {
    const args = [
      payload,
      String(this.maxTurns ?? 0),
      String(this.ttlSeconds ?? 0)
    ];

    if (this.client.evalSha && this.appendScriptSha) {
      try {
        await this.client.evalSha(this.appendScriptSha, { keys: [key], arguments: args });
        return;
      } catch (error) {
        const message = (error as Error).message ?? "";
        if (!message.includes("NOSCRIPT")) {
          throw error;
        }
      }
    }

    if (this.client.scriptLoad) {
      this.appendScriptSha = await this.client.scriptLoad(APPEND_AND_TRIM_SCRIPT);
      if (this.client.evalSha) {
        await this.client.evalSha(this.appendScriptSha, { keys: [key], arguments: args });
        return;
      }
    }

    if (this.client.eval) {
      await this.client.eval(APPEND_AND_TRIM_SCRIPT, { keys: [key], arguments: args });
      return;
    }

    await this.fallbackAppend(key, payload);
  }

  private async fallbackAppend(key: string, payload: string): Promise<void> {
    if (this.client.multi) {
      const pipeline = this.client.multi();
      pipeline.rPush(key, payload);
      if (this.maxTurns && this.maxTurns > 0) {
        pipeline.lTrim(key, -this.maxTurns, -1);
      }
      if (this.ttlSeconds && this.ttlSeconds > 0 && pipeline.expire) {
        pipeline.expire(key, this.ttlSeconds);
      }
      await pipeline.exec();
      return;
    }

    await this.client.rPush(key, payload);
    if (this.maxTurns && this.maxTurns > 0) {
      await this.client.lTrim(key, -this.maxTurns, -1);
    }
    if (this.ttlSeconds && this.ttlSeconds > 0 && this.client.expire) {
      await this.client.expire(key, this.ttlSeconds);
    }
  }

  private async replaceSession(key: string, entries: string[]): Promise<void> {
    if (this.client.multi) {
      const tx = this.client.multi();
      if (tx.del && this.client.del) {
        tx.del(key);
      } else {
        tx.lTrim(key, 1, 0);
      }
      for (const entry of entries) {
        tx.rPush(key, entry);
      }
      if (this.ttlSeconds && this.ttlSeconds > 0 && tx.expire) {
        tx.expire(key, this.ttlSeconds);
      }
      await tx.exec();
      return;
    }

    if (this.client.del) {
      await this.client.del(key);
    } else {
      await this.client.lTrim(key, 1, 0);
    }
    for (const entry of entries) {
      await this.client.rPush(key, entry);
    }
    if (this.ttlSeconds && this.ttlSeconds > 0 && this.client.expire) {
      await this.client.expire(key, this.ttlSeconds);
    }
  }

  private async ensureTtl(key: string): Promise<void> {
    if (this.ttlSeconds && this.ttlSeconds > 0 && this.client.expire) {
      await this.client.expire(key, this.ttlSeconds);
    }
  }

  private getSessionKey(sessionId: string): string {
    if (!sessionId) {
      throw new Error("sessionId is required");
    }
    return this.namespace ? `${this.namespace}:${sessionId}` : sessionId;
  }

  private serialiseTurn(turn: MemoryTurn): MemoryTurn {
    return {
      ...turn,
      createdAt: turn.createdAt ? new Date(turn.createdAt) : undefined
    };
  }

  private deserialiseTurn(raw: string): MemoryTurn {
    const parsed = JSON.parse(raw) as MemoryTurn;
    const createdAt = parsed.createdAt ? new Date(parsed.createdAt) : undefined;
    return {
      ...parsed,
      createdAt,
    };
  }

  private cloneTurn(turn: MemoryTurn): MemoryTurn {
    return {
      ...turn,
      createdAt: turn.createdAt ? new Date(turn.createdAt) : undefined,
    };
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
    if (turn.tokens != null) {
      return { ...turn, tokens: turn.tokens };
    }

    const createdAt = turn.createdAt ?? new Date();
    const tokens = this.tokenCounter.count(turn.content);
    return {
      ...turn,
      tokens,
      createdAt,
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
      return this.cloneTurn(turn);
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

export { APPEND_AND_TRIM_SCRIPT };

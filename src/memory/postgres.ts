import type {
  MemoryGetContextOptions,
  MemoryManager,
  MemoryRole,
  MemoryTrimOptions,
  MemoryTurn,
} from "./types.js";
import { defaultTokenCounter, type TokenCounter } from "./tokenizer.js";

export interface PgClientLike {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  release(): void | Promise<void>;
}

export interface PgPoolLike {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  connect(): Promise<PgClientLike>;
}

export interface PostgresMemoryManagerOptions {
  pool: PgPoolLike;
  schema?: string;
  tableName?: string;
  maxTurns?: number;
  tokenCounter?: TokenCounter;
  summaryMaxRecentTurns?: number;
  summaryRole?: MemoryRole;
  summarizer?: (turns: MemoryTurn[]) => unknown;
}

const DEFAULT_TABLE_NAME = "agent_memory_turns";
const DEFAULT_SUMMARY_RECENT_TURNS = 4;
const DEFAULT_SUMMARY_ROLE: MemoryRole = "summary";

interface DbTurnRow {
  id: number;
  session_id: string;
  role: MemoryRole;
  content: unknown;
  tokens: number | null;
  created_at: Date | string | null;
}

function cloneTurn(turn: MemoryTurn): MemoryTurn {
  return {
    ...turn,
    createdAt: turn.createdAt ? new Date(turn.createdAt) : undefined,
    tokens: turn.tokens,
  };
}

export class PostgresMemoryManager implements MemoryManager {
  private readonly pool: PgPoolLike;
  private readonly qualifiedTable: string;
  private readonly maxTurns?: number;
  private readonly tokenCounter: TokenCounter;
  private readonly summaryMaxRecentTurns: number;
  private readonly summaryRole: MemoryRole;
  private readonly summarizer?: (turns: MemoryTurn[]) => unknown;

  constructor(options: PostgresMemoryManagerOptions) {
    if (!options || !options.pool) {
      throw new Error("PostgresMemoryManager requires a pg Pool instance");
    }

    this.pool = options.pool;
    this.maxTurns = options.maxTurns;
    this.tokenCounter = options.tokenCounter ?? defaultTokenCounter;
    this.summaryMaxRecentTurns = options.summaryMaxRecentTurns ?? DEFAULT_SUMMARY_RECENT_TURNS;
    this.summaryRole = options.summaryRole ?? DEFAULT_SUMMARY_ROLE;
    this.summarizer = options.summarizer;
    this.qualifiedTable = this.buildQualifiedTable(options.schema, options.tableName ?? DEFAULT_TABLE_NAME);
  }

  async append(sessionId: string, turn: MemoryTurn): Promise<void> {
    await this.withTransaction(async (client) => {
      const normalised = this.withTokenMetadata(turn);
      await this.insertTurn(client, sessionId, normalised);

      if (this.maxTurns && this.maxTurns > 0) {
        await client.query(
          `DELETE FROM ${this.qualifiedTable}
           WHERE id IN (
             SELECT id FROM ${this.qualifiedTable}
             WHERE session_id = $1
             ORDER BY created_at DESC, id DESC
             OFFSET $2
           )`,
          [sessionId, this.maxTurns]
        );
      }
    });
  }

  async getContext(sessionId: string, options: MemoryGetContextOptions = {}): Promise<MemoryTurn[]> {
    const { maxTokens, maxTurns } = options;
    const params: unknown[] = [sessionId];
    let query = `SELECT id, role, content, tokens, created_at
      FROM ${this.qualifiedTable}
      WHERE session_id = $1
      ORDER BY created_at DESC, id DESC`;

    if (maxTurns && maxTurns > 0) {
      params.push(maxTurns);
      query += ` LIMIT $2`;
    }

    const { rows } = await this.pool.query<DbTurnRow>(query, params);
    if (!rows || rows.length === 0) {
      return [];
    }

    const ordered = rows.reverse().map((row) => this.rowToTurn(row));
    if (maxTokens == null) {
      return ordered.map((turn) => cloneTurn(turn));
    }

    const result: MemoryTurn[] = [];
    let remainingTokens = maxTokens;

    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const current = this.withTokenMetadata(ordered[index]);
      const tokens = current.tokens ?? 0;

      if (tokens > remainingTokens) {
        const truncated = this.truncateTurnToBudget(current, remainingTokens);
        if (truncated) {
          result.unshift(truncated);
        }
        break;
      }

      result.unshift(cloneTurn(current));
      remainingTokens -= tokens;
      if (remainingTokens <= 0) {
        break;
      }
    }

    return result;
  }

  async summarize(sessionId: string): Promise<void> {
    await this.withTransaction(async (client) => {
      const { rows } = await client.query<DbTurnRow>(
        `SELECT id, role, content, tokens, created_at
         FROM ${this.qualifiedTable}
         WHERE session_id = $1
         ORDER BY created_at ASC, id ASC`,
        [sessionId]
      );

      if (!rows || rows.length === 0 || rows.length <= this.summaryMaxRecentTurns) {
        return;
      }

      const cutoff = Math.max(0, rows.length - this.summaryMaxRecentTurns);
      const historicRows = rows.slice(0, cutoff);
      const recentRows = rows.slice(cutoff);

      if (historicRows.length === 0) {
        return;
      }

      const historicTurns = historicRows.map((row) => this.rowToTurn(row));
      const recentTurns = recentRows.map((row) => this.rowToTurn(row));

      const summaryContent = this.summarizer
        ? this.summarizer(historicTurns.map((turn) => cloneTurn(turn)))
        : this.defaultSummarize(historicTurns);

      const summaryTurn = this.withTokenMetadata({
        role: this.summaryRole,
        content: summaryContent,
        createdAt: new Date(),
      });

      await client.query(`DELETE FROM ${this.qualifiedTable} WHERE session_id = $1`, [sessionId]);

      await this.insertTurn(client, sessionId, summaryTurn);
      for (const turn of recentTurns) {
        await this.insertTurn(client, sessionId, this.withTokenMetadata(turn));
      }
    });
  }

  async trim(sessionId: string, options: MemoryTrimOptions = {}): Promise<void> {
    const retainTurns = options.retainTurns ?? this.maxTurns;

    if (!retainTurns || retainTurns <= 0) {
      await this.pool.query(`DELETE FROM ${this.qualifiedTable} WHERE session_id = $1`, [sessionId]);
      return;
    }

    await this.pool.query(
      `DELETE FROM ${this.qualifiedTable}
       WHERE id IN (
         SELECT id FROM ${this.qualifiedTable}
         WHERE session_id = $1
         ORDER BY created_at DESC, id DESC
         OFFSET $2
       )`,
      [sessionId, retainTurns]
    );
  }

  private async insertTurn(client: PgClientLike, sessionId: string, turn: MemoryTurn): Promise<void> {
    const createdAt = turn.createdAt ? new Date(turn.createdAt) : new Date();
    const payload = {
      sessionId,
      role: turn.role,
      content: turn.content,
      tokens: turn.tokens ?? null,
      createdAt,
    };

    const serialisedContent = JSON.stringify(payload.content ?? null);

    await client.query(
      `INSERT INTO ${this.qualifiedTable} (session_id, role, content, tokens, created_at)
       VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [payload.sessionId, payload.role, serialisedContent, payload.tokens, createdAt]
    );
  }

  private rowToTurn(row: DbTurnRow): MemoryTurn {
    const createdAt = row.created_at ? new Date(row.created_at) : undefined;
    const tokens = row.tokens == null ? undefined : row.tokens;
    return {
      role: row.role,
      content: row.content,
      tokens,
      createdAt,
    };
  }

  private withTokenMetadata(turn: MemoryTurn): MemoryTurn {
    if (turn.tokens != null) {
      return {
        ...turn,
        tokens: turn.tokens,
        createdAt: turn.createdAt ? new Date(turn.createdAt) : new Date(),
      };
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

  private buildQualifiedTable(schema: string | undefined, tableName: string): string {
    const table = this.quoteIdentifier(tableName);
    if (!schema) {
      return table;
    }

    return `${this.quoteIdentifier(schema)}.${table}`;
  }

  private quoteIdentifier(identifier: string): string {
    if (!/^[a-zA-Z0-9_]+$/.test(identifier)) {
      throw new Error(`Invalid identifier: ${identifier}`);
    }

    return `"${identifier}"`;
  }

  private async withTransaction<T>(handler: (client: PgClientLike) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await handler(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Ignore rollback errors so we surface the original failure.
      }
      throw error;
    } finally {
      await client.release();
    }
  }
}

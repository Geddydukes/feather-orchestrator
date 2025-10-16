import { Pool, type PoolClient, type PoolConfig } from "pg";
import {
  type BaseMemoryOptions,
  type MemoryContext,
  type MemoryContextRequest,
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

export interface PostgresMemoryManagerOptions extends BaseMemoryOptions {
  pool?: Pool;
  poolConfig?: PoolConfig;
  schema?: string;
  ensureSchema?: boolean;
}

const DEFAULT_SCHEMA = "public";

const ensureTablesSQL = (schema: string) => `
CREATE TABLE IF NOT EXISTS ${schema}.memory_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  message_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ${schema}.memory_messages (
  id UUID PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES ${schema}.memory_sessions(session_id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  tokens INTEGER,
  sequence INTEGER
);

CREATE INDEX IF NOT EXISTS memory_messages_session_idx ON ${schema}.memory_messages(session_id, created_at);
`;

export class PostgresMemoryManager implements MemoryManager {
  private pool: Pool;
  private options: Required<Pick<BaseMemoryOptions, "maxMessages" | "defaultTTLSeconds" | "contextWindowTokens">> &
    Partial<BaseMemoryOptions> & { schema: string; ensureSchema: boolean };
  private ready: Promise<void>;

  constructor(opts: PostgresMemoryManagerOptions = {}) {
    this.pool = opts.pool ?? new Pool(opts.poolConfig);
    this.options = {
      maxMessages: opts.maxMessages ?? DEFAULT_MAX_MESSAGES,
      defaultTTLSeconds: opts.defaultTTLSeconds ?? 60 * 60 * 24,
      contextWindowTokens: opts.contextWindowTokens ?? undefined,
      compressor: opts.compressor,
      tokenizer: opts.tokenizer ?? defaultTokenizer,
      hooks: opts.hooks,
      schema: opts.schema ?? DEFAULT_SCHEMA,
      ensureSchema: opts.ensureSchema ?? true
    } as typeof this.options;

    this.ready = this.initialize();
  }

  private async initialize() {
    if (this.options.ensureSchema) {
      await this.pool.query(ensureTablesSQL(this.options.schema));
    }
  }

  private async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.ready;
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  private sessionTable() {
    return `${this.options.schema}.memory_sessions`;
  }

  private messageTable() {
    return `${this.options.schema}.memory_messages`;
  }

  async appendMessages(sessionId: string, inputs: MemoryMessageInput[], opts?: MemoryWriteOptions): Promise<MemoryMessage[]> {
    if (inputs.length === 0) return [];
    return this.withClient(async (client) => {
      const { durationMs, value } = await time(async () => {
        await client.query("BEGIN");
        try {
          const now = new Date();
          const expiresAt = opts?.ttlSeconds ? new Date(now.getTime() + opts.ttlSeconds * 1000) : null;
          await client.query(
            `INSERT INTO ${this.sessionTable()} (session_id, user_id, metadata, created_at, updated_at, expires_at)
             VALUES ($1, $2, $3, $4, $4, $5)
             ON CONFLICT (session_id) DO UPDATE SET
               user_id = COALESCE(EXCLUDED.user_id, ${this.sessionTable()}.user_id),
               metadata = CASE
                 WHEN EXCLUDED.metadata IS NULL THEN ${this.sessionTable()}.metadata
                 WHEN ${this.sessionTable()}.metadata IS NULL THEN EXCLUDED.metadata
                 ELSE ${this.sessionTable()}.metadata || EXCLUDED.metadata
               END,
               updated_at = EXCLUDED.updated_at,
               expires_at = COALESCE(EXCLUDED.expires_at, ${this.sessionTable()}.expires_at)
            `,
            [sessionId, opts?.userId ?? null, opts?.metadata ?? null, now, expiresAt]
          );

          const startSequenceRes = await client.query(
            `SELECT message_count FROM ${this.sessionTable()} WHERE session_id = $1`,
            [sessionId]
          );
          const startSequence = Number(startSequenceRes.rows[0]?.message_count ?? 0);

          const stored = inputs.map((input, idx) =>
            realizeMessage(sessionId, input, startSequence + idx, this.options.tokenizer)
          );

          for (const msg of stored) {
            await client.query(
              `INSERT INTO ${this.messageTable()} (id, session_id, role, content, metadata, created_at, tokens, sequence)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [msg.id, sessionId, msg.role, msg.content, msg.metadata ?? null, msg.createdAt, msg.tokens ?? null, msg.sequence ?? null]
            );
          }

          await client.query(
            `UPDATE ${this.sessionTable()} SET message_count = message_count + $2, updated_at = $3 WHERE session_id = $1`,
            [sessionId, stored.length, new Date()]
          );

          const overflow = await client.query<{ id: string }>(
            `SELECT id FROM ${this.messageTable()}
             WHERE session_id = $1
             ORDER BY created_at DESC
             OFFSET $2`,
            [sessionId, this.options.maxMessages]
          );

          if (overflow.rowCount && overflow.rowCount > 0) {
            const ids = overflow.rows.map((row) => row.id);
            await client.query(
              `DELETE FROM ${this.messageTable()} WHERE id = ANY($1::uuid[])`,
              [ids]
            );
            await client.query(
              `UPDATE ${this.sessionTable()} SET message_count = $2 WHERE session_id = $1`,
              [sessionId, this.options.maxMessages]
            );
          }

          await client.query("COMMIT");
          return stored;
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        }
      });

      this.options.hooks?.onWrite?.({ sessionId, messages: value.length, durationMs });
      return value;
    });
  }

  async loadContext(sessionId: string, opts?: MemoryContextRequest): Promise<MemoryContext> {
    return this.withClient(async (client) => {
      const { durationMs, value } = await time(async () => {
        const res = await client.query<{
          id: string;
          session_id: string;
          role: string;
          content: string;
          metadata: Record<string, unknown> | null;
          created_at: Date;
          tokens: number | null;
          sequence: number | null;
        }>(
          `SELECT id, session_id, role, content, metadata, created_at, tokens, sequence
           FROM ${this.messageTable()}
           WHERE session_id = $1
           ORDER BY created_at ASC`,
          [sessionId]
        );
        const messages: MemoryMessage[] = res.rows.map((row) => ({
          id: row.id,
          sessionId: row.session_id,
          role: row.role as MemoryMessage["role"],
          content: row.content,
          metadata: row.metadata ?? undefined,
          createdAt: row.created_at,
          tokens: row.tokens ?? undefined,
          sequence: row.sequence ?? undefined
        }));
        return computeContext(sessionId, messages, opts, {
          maxMessages: this.options.maxMessages,
          contextWindowTokens: this.options.contextWindowTokens,
          compressor: this.options.compressor,
          tokenizer: this.options.tokenizer
        });
      });

      this.options.hooks?.onRead?.({ sessionId, messages: value.messages.length, strategy: opts?.strategy ?? "hybrid", durationMs });

      if (opts?.includeMetadata) {
        const sessionRes = await client.query(
          `SELECT user_id, metadata, created_at, updated_at, expires_at, message_count
           FROM ${this.sessionTable()} WHERE session_id = $1`,
          [sessionId]
        );
        if (sessionRes.rowCount > 0) {
          const session = sessionRes.rows[0];
          return {
            ...value,
            metadata: session.metadata ?? undefined,
            expiresAt: session.expires_at ?? undefined
          };
        }
      }

      return value;
    });
  }

  async listSessions(filter?: SessionFilter): Promise<MemorySession[]> {
    return this.withClient(async (client) => {
      const clauses: string[] = [];
      const params: any[] = [];
      let idx = 1;
      if (filter?.userId) {
        clauses.push(`user_id = $${idx}`);
        params.push(filter.userId);
        idx += 1;
      }
      if (filter?.before) {
        clauses.push(`updated_at < $${idx}`);
        params.push(filter.before);
        idx += 1;
      }
      if (filter?.after) {
        clauses.push(`updated_at > $${idx}`);
        params.push(filter.after);
        idx += 1;
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const res = await client.query<{
        session_id: string;
        user_id: string | null;
        metadata: Record<string, unknown> | null;
        created_at: Date;
        updated_at: Date;
        expires_at: Date | null;
        message_count: number | null;
      }>(
        `SELECT session_id, user_id, metadata, created_at, updated_at, expires_at, message_count
         FROM ${this.sessionTable()} ${where}
         ORDER BY updated_at DESC`,
        params
      );
      return res.rows.map((row) =>
        toMemorySession(row.session_id, {
          userId: row.user_id ?? undefined,
          metadata: row.metadata ?? undefined,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          expiresAt: row.expires_at ?? undefined,
          messageCount: row.message_count ?? 0
        })
      );
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.withClient(async (client) => {
      await client.query("BEGIN");
      try {
        const countRes = await client.query(
          `SELECT COUNT(*)::int AS count FROM ${this.messageTable()} WHERE session_id = $1`,
          [sessionId]
        );
        await client.query(`DELETE FROM ${this.messageTable()} WHERE session_id = $1`, [sessionId]);
        await client.query(`DELETE FROM ${this.sessionTable()} WHERE session_id = $1`, [sessionId]);
        await client.query("COMMIT");
        const deleted = Number(countRes.rows[0]?.count ?? 0);
        this.options.hooks?.onDelete?.({ sessionId, messages: deleted });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    });
  }

  async deleteMessages(sessionId: string, predicate: (message: MemoryMessage) => boolean): Promise<number> {
    return this.withClient(async (client) => {
      const res = await client.query<{
        id: string;
        session_id: string;
        role: string;
        content: string;
        metadata: Record<string, unknown> | null;
        created_at: Date;
        tokens: number | null;
        sequence: number | null;
      }>(
        `SELECT id, session_id, role, content, metadata, created_at, tokens, sequence
         FROM ${this.messageTable()} WHERE session_id = $1`,
        [sessionId]
      );
      const messages: MemoryMessage[] = res.rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        role: row.role as MemoryMessage["role"],
        content: row.content,
        metadata: row.metadata ?? undefined,
        createdAt: row.created_at,
        tokens: row.tokens ?? undefined,
        sequence: row.sequence ?? undefined
      }));
      const toDelete = messages.filter((msg) => predicate(msg)).map((msg) => msg.id);
      if (toDelete.length === 0) return 0;
      await client.query(
        `DELETE FROM ${this.messageTable()} WHERE id = ANY($1::uuid[])`,
        [toDelete]
      );
      await client.query(
        `UPDATE ${this.sessionTable()} SET message_count = GREATEST(message_count - $2, 0) WHERE session_id = $1`,
        [sessionId, toDelete.length]
      );
      this.options.hooks?.onDelete?.({ sessionId, messages: toDelete.length });
      return toDelete.length;
    });
  }

  async touchSession(sessionId: string, ttlSeconds?: number): Promise<void> {
    await this.withClient(async (client) => {
      const ttl = ttlSeconds ?? this.options.defaultTTLSeconds;
      const expiresAt = ttl ? new Date(Date.now() + ttl * 1000) : null;
      await client.query(
        `UPDATE ${this.sessionTable()} SET updated_at = $2, expires_at = COALESCE($3, expires_at) WHERE session_id = $1`,
        [sessionId, new Date(), expiresAt]
      );
    });
  }

  async pruneExpired(): Promise<number> {
    return this.withClient(async (client) => {
      const res = await client.query<{ session_id: string }>(
        `SELECT session_id FROM ${this.sessionTable()} WHERE expires_at IS NOT NULL AND expires_at <= NOW()`
      );
      const sessionIds = res.rows.map((row) => row.session_id as string);
      if (sessionIds.length === 0) return 0;
      await client.query("BEGIN");
      try {
        await client.query(
          `DELETE FROM ${this.messageTable()} WHERE session_id = ANY($1::text[])`,
          [sessionIds]
        );
        await client.query(
          `DELETE FROM ${this.sessionTable()} WHERE session_id = ANY($1::text[])`,
          [sessionIds]
        );
        await client.query("COMMIT");
        for (const sessionId of sessionIds) {
          this.options.hooks?.onDelete?.({ sessionId, messages: 0 });
        }
        return sessionIds.length;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    });
  }

  async stats(): Promise<MemoryStats> {
    return this.withClient(async (client) => {
      const sessionsRes = await client.query(`SELECT COUNT(*)::int AS count FROM ${this.sessionTable()}`);
      const messagesRes = await client.query(`SELECT COUNT(*)::int AS count FROM ${this.messageTable()}`);
      const expiredRes = await client.query(
        `SELECT COUNT(*)::int AS count FROM ${this.sessionTable()} WHERE expires_at IS NOT NULL AND expires_at <= NOW()`
      );
      return {
        sessions: Number(sessionsRes.rows[0]?.count ?? 0),
        messages: Number(messagesRes.rows[0]?.count ?? 0),
        expiredSessions: Number(expiredRes.rows[0]?.count ?? 0)
      };
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

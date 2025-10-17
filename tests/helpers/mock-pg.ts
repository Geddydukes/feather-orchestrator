import type { PgClientLike, PgPoolLike } from "../../src/memory/postgres.js";

type QueryResult = { rows: unknown[] };

type QueryHandler = (text: string, params: unknown[]) => Promise<QueryResult>;

interface StoredRow {
  id: number;
  sessionId: string;
  role: string;
  content: unknown;
  tokens: number | null;
  createdAt: Date;
}

export class MockPgPool implements PgPoolLike {
  private readonly rows: StoredRow[] = [];
  private nextId = 1;

  async query<T = unknown>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    return (await this.execute(text, params)) as { rows: T[] };
  }

  async connect(): Promise<PgClientLike> {
    const execute: QueryHandler = (text, params) => this.execute(text, params);
    return new MockPgClient(execute);
  }

  private async execute(text: string, params: unknown[]): Promise<QueryResult> {
    const sql = text.trim().toUpperCase();

    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [] };
    }

    if (sql.startsWith("INSERT INTO")) {
      return this.insert(params);
    }

    if (sql.startsWith("DELETE FROM")) {
      if (sql.includes("OFFSET")) {
        return this.deleteWithOffset(params);
      }
      return this.deleteAll(params);
    }

    if (sql.startsWith("SELECT ID, ROLE, CONTENT, TOKENS, CREATED_AT")) {
      const orderAsc = sql.includes("ORDER BY CREATED_AT ASC");
      const hasLimit = sql.includes("LIMIT");
      return this.select(params, orderAsc, hasLimit);
    }

    throw new Error(`Unsupported query: ${text}`);
  }

  private async insert(params: unknown[]): Promise<QueryResult> {
    const [sessionId, role, contentRaw, tokensRaw, createdAtRaw] = params;
    const createdAt = createdAtRaw instanceof Date ? createdAtRaw : new Date(String(createdAtRaw));
    let content: unknown = contentRaw;
    if (typeof contentRaw === "string") {
      try {
        content = JSON.parse(contentRaw);
      } catch {
        content = contentRaw;
      }
    }

    this.rows.push({
      id: this.nextId,
      sessionId: String(sessionId),
      role: String(role),
      content,
      tokens: tokensRaw == null ? null : Number(tokensRaw),
      createdAt,
    });
    this.nextId += 1;
    return { rows: [] };
  }

  private async deleteWithOffset(params: unknown[]): Promise<QueryResult> {
    const [sessionId, retainRaw] = params;
    const retain = Number(retainRaw);
    const retained = this.rows
      .filter((row) => row.sessionId === String(sessionId))
      .sort((a, b) => this.compareDesc(a, b))
      .slice(0, retain);

    const retainedIds = new Set(retained.map((row) => row.id));
    this.replaceRows((row) => row.sessionId !== String(sessionId) || retainedIds.has(row.id));
    return { rows: [] };
  }

  private async deleteAll(params: unknown[]): Promise<QueryResult> {
    const [sessionId] = params;
    this.replaceRows((row) => row.sessionId !== String(sessionId));
    return { rows: [] };
  }

  private async select(params: unknown[], orderAsc: boolean, hasLimit: boolean): Promise<QueryResult> {
    const [sessionId, limitRaw] = params;
    let matching = this.rows.filter((row) => row.sessionId === String(sessionId));
    matching = matching.sort(orderAsc ? this.compareAsc : this.compareDesc);

    if (hasLimit && limitRaw != null) {
      matching = matching.slice(0, Number(limitRaw));
    }

    const rows = matching.map((row) => ({
      ...row,
      session_id: row.sessionId,
      created_at: row.createdAt,
    }));
    return { rows };
  }

  private replaceRows(predicate: (row: StoredRow) => boolean): void {
    const retained = this.rows.filter(predicate);
    this.rows.length = 0;
    this.rows.push(...retained);
  }

  private compareAsc = (a: StoredRow, b: StoredRow): number => {
    const timeDiff = a.createdAt.getTime() - b.createdAt.getTime();
    if (timeDiff !== 0) {
      return timeDiff;
    }
    return a.id - b.id;
  };

  private compareDesc = (a: StoredRow, b: StoredRow): number => {
    const timeDiff = b.createdAt.getTime() - a.createdAt.getTime();
    if (timeDiff !== 0) {
      return timeDiff;
    }
    return b.id - a.id;
  };
}

class MockPgClient implements PgClientLike {
  constructor(private readonly handler: QueryHandler) {}

  async query<T = unknown>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    return (await this.handler(text, params)) as { rows: T[] };
  }

  async release(): Promise<void> {
    // no-op for the in-memory mock
  }
}

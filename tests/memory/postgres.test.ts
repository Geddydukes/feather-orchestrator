import { beforeEach, describe, expect, it } from "vitest";

import { PostgresMemoryManager } from "../../src/memory/postgres.js";
import type { MemoryTurn } from "../../src/memory/types.js";
import { MockPgPool } from "../helpers/mock-pg.js";

const SESSION_ID = "session-postgres";

describe("PostgresMemoryManager", () => {
  let pool: MockPgPool;
  let memory: PostgresMemoryManager;

  beforeEach(() => {
    pool = new MockPgPool();
    memory = new PostgresMemoryManager({ pool });
  });

  it("stores and retrieves turns with token metadata", async () => {
    const turns: MemoryTurn[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: { text: "world" } },
    ];

    for (const turn of turns) {
      await memory.append(SESSION_ID, turn);
    }

    const context = await memory.getContext(SESSION_ID);
    expect(context).toHaveLength(2);
    expect(context[0].content).toBe("hello");
    expect(context[1].content).toEqual({ text: "world" });
    expect(context.every((turn) => typeof turn.tokens === "number")).toBe(true);
  });

  it("respects token budgets when retrieving context", async () => {
    await memory.append(SESSION_ID, { role: "user", content: "short" });
    await memory.append(SESSION_ID, {
      role: "assistant",
      content: "this is a considerably longer answer that should be truncated",
    });

    const context = await memory.getContext(SESSION_ID, { maxTokens: 6 });
    expect(context).toHaveLength(1);
    expect(context[0].role).toBe("assistant");
    expect(typeof context[0].content).toBe("string");
    expect((context[0].tokens ?? 0)).toBeLessThanOrEqual(6);
  });

  it("trims history to configured turn limit on append", async () => {
    memory = new PostgresMemoryManager({ pool, maxTurns: 3 });

    for (let index = 0; index < 5; index += 1) {
      await memory.append(SESSION_ID, { role: "user", content: `turn ${index}` });
    }

    const context = await memory.getContext(SESSION_ID);
    expect(context).toHaveLength(3);
    expect(context.map((turn) => turn.content)).toEqual([
      "turn 2",
      "turn 3",
      "turn 4",
    ]);
  });

  it("summarises older turns while keeping recent ones", async () => {
    memory = new PostgresMemoryManager({ pool, summaryMaxRecentTurns: 2 });

    await memory.append(SESSION_ID, { role: "user", content: "alpha" });
    await memory.append(SESSION_ID, { role: "assistant", content: "beta" });
    await memory.append(SESSION_ID, { role: "user", content: "gamma" });
    await memory.append(SESSION_ID, { role: "assistant", content: "delta" });

    await memory.summarize(SESSION_ID);
    const context = await memory.getContext(SESSION_ID);

    expect(context).toHaveLength(3);
    expect(context[0].role).toBe("summary");
    expect(context[1].content).toBe("gamma");
    expect(context[2].content).toBe("delta");
  });

  it("supports explicit trimming requests", async () => {
    for (let index = 0; index < 4; index += 1) {
      await memory.append(SESSION_ID, { role: "assistant", content: `item ${index}` });
    }

    await memory.trim(SESSION_ID, { retainTurns: 2 });
    let context = await memory.getContext(SESSION_ID);
    expect(context).toHaveLength(2);
    expect(context.map((turn) => turn.content)).toEqual(["item 2", "item 3"]);

    await memory.trim(SESSION_ID, { retainTurns: 0 });
    context = await memory.getContext(SESSION_ID);
    expect(context).toHaveLength(0);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { RedisMemoryManager } from "../../src/memory/redis.js";
import type { MemoryTurn } from "../../src/memory/types.js";
import { MockRedisClient } from "../helpers/mock-redis.js";

const SESSION_ID = "session-redis";
const NAMESPACE = "agent";

describe("RedisMemoryManager", () => {
  let client: MockRedisClient;
  let memory: RedisMemoryManager;

  beforeEach(() => {
    client = new MockRedisClient();
    memory = new RedisMemoryManager({
      client,
      namespace: NAMESPACE,
      maxTurns: 6,
      ttlSeconds: 60,
    });
  });

  it("stores and retrieves turns with token metadata", async () => {
    const turns: MemoryTurn[] = [
      { role: "user", content: "ping" },
      { role: "assistant", content: "pong" },
    ];

    for (const turn of turns) {
      await memory.append(SESSION_ID, turn);
    }

    const context = await memory.getContext(SESSION_ID);
    expect(context).toHaveLength(2);
    expect(context.map((turn) => turn.content)).toEqual(["ping", "pong"]);
    expect(context.every((turn) => typeof turn.tokens === "number")).toBe(true);
  });

  it("respects max token budgets when retrieving context", async () => {
    await memory.append(SESSION_ID, { role: "user", content: "short" });
    await memory.append(SESSION_ID, {
      role: "assistant",
      content: "this is a considerably longer answer that should be truncated",
    });

    const context = await memory.getContext(SESSION_ID, { maxTokens: 5 });
    expect(context).toHaveLength(1);
    expect(context[0].role).toBe("assistant");
    expect((context[0].content as string).endsWith("…")).toBe(true);
    expect((context[0].tokens ?? 0)).toBeLessThanOrEqual(5);
  });

  it("trims history to configured turn limit", async () => {
    memory = new RedisMemoryManager({
      client,
      namespace: NAMESPACE,
      maxTurns: 3,
    });

    for (let index = 0; index < 5; index += 1) {
      await memory.append(SESSION_ID, { role: "user", content: `message ${index}` });
    }

    const context = await memory.getContext(SESSION_ID);
    expect(context).toHaveLength(3);
    expect(context.map((turn) => turn.content)).toEqual([
      "message 2",
      "message 3",
      "message 4",
    ]);
  });

  it("summarises older turns while keeping recent ones", async () => {
    memory = new RedisMemoryManager({
      client,
      namespace: NAMESPACE,
      summaryMaxRecentTurns: 2,
    });

    await memory.append(SESSION_ID, { role: "user", content: "first" });
    await memory.append(SESSION_ID, { role: "assistant", content: "second" });
    await memory.append(SESSION_ID, { role: "user", content: "third" });
    await memory.append(SESSION_ID, { role: "assistant", content: "fourth" });

    await memory.summarize(SESSION_ID);
    const context = await memory.getContext(SESSION_ID);

    expect(context).toHaveLength(3);
    expect(context[0].role).toBe("summary");
    expect(context[1].content).toBe("third");
    expect(context[2].content).toBe("fourth");
  });

  it("supports trimming sessions explicitly", async () => {
    for (let index = 0; index < 4; index += 1) {
      await memory.append(SESSION_ID, { role: "user", content: `turn ${index}` });
    }

    await memory.trim(SESSION_ID, { retainTurns: 1 });
    const context = await memory.getContext(SESSION_ID);

    expect(context).toHaveLength(1);
    expect(context[0].content).toBe("turn 3");

    await memory.trim(SESSION_ID, { retainTurns: 0 });
    const cleared = await memory.getContext(SESSION_ID);
    expect(cleared).toHaveLength(0);
  });

  it("applies TTLs to stored sessions", async () => {
    await memory.append(SESSION_ID, { role: "user", content: "hello" });
    const key = `${NAMESPACE}:${SESSION_ID}`;

    const expiryMs = client.getExpiry(key);
    expect(expiryMs).toBeGreaterThan(0);
    expect(expiryMs).toBeLessThanOrEqual(60000);

    client.advanceTime(60000);
    const context = await memory.getContext(SESSION_ID);
    expect(context).toHaveLength(0);
  });

  it("handles concurrent appends deterministically", async () => {
    memory = new RedisMemoryManager({
      client,
      namespace: NAMESPACE,
      maxTurns: 4,
    });

    await Promise.all(
      Array.from({ length: 8 }).map((_, index) =>
        memory.append(SESSION_ID, { role: "user", content: `event ${index}` })
      )
    );

    const context = await memory.getContext(SESSION_ID);
    expect(context).toHaveLength(4);
    expect(context.map((turn) => turn.content)).toEqual([
      "event 4",
      "event 5",
      "event 6",
      "event 7",
    ]);
  });
});

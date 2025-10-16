import { describe, expect, it, beforeEach, vi } from "vitest";
import { InMemoryMemoryManager } from "../src/memory/inMemory.js";
import type { MemoryContext } from "../src/memory/types.js";

describe("InMemoryMemoryManager", () => {
  let manager: InMemoryMemoryManager;

  beforeEach(() => {
    manager = new InMemoryMemoryManager({ maxMessages: 5, defaultTTLSeconds: 60 });
  });

  it("stores and retrieves messages", async () => {
    await manager.appendMessages(
      "session-1",
      [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" }
      ],
      { userId: "user-123" }
    );

    const context = (await manager.loadContext("session-1", { includeMetadata: true })) as MemoryContext;
    expect(context.sessionId).toBe("session-1");
    expect(context.messages).toHaveLength(2);
    expect(context.messages[0].content).toBe("Hello");
    expect(context.messages[1].content).toBe("Hi there");
  });

  it("truncates messages when exceeding token limit", async () => {
    await manager.appendMessages(
      "session-2",
      Array.from({ length: 10 }).map((_, idx) => ({
        role: idx % 2 === 0 ? "user" : "assistant",
        content: `message-${idx}`
      }))
    );

    const context = await manager.loadContext("session-2", { strategy: "truncate", maxTokens: 10 });
    expect(context.messages.length).toBeLessThanOrEqual(5);
    expect(context.omittedMessages).toBeGreaterThan(0);
  });

  it("expires sessions using ttl", async () => {
    vi.useFakeTimers();
    const ttlManager = new InMemoryMemoryManager({ maxMessages: 5, defaultTTLSeconds: 1 });
    await ttlManager.appendMessages("session-ttl", [{ role: "user", content: "temp" }]);

    vi.advanceTimersByTime(2000);
    await ttlManager.pruneExpired();
    const context = await ttlManager.loadContext("session-ttl");
    expect(context.messages).toHaveLength(0);
    vi.useRealTimers();
  });
});

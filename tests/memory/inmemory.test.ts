import { describe, expect, it, beforeEach } from "vitest";
import { InMemoryMemoryManager } from "../../src/memory/inmemory.js";
import { BasicTokenCounter } from "../../src/memory/tokenizer.js";
import type { MemoryTurn } from "../../src/memory/types.js";

const SESSION_ID = "session-1";

describe("InMemoryMemoryManager", () => {
  let memory: InMemoryMemoryManager;

  beforeEach(() => {
    memory = new InMemoryMemoryManager();
  });

  it("stores and retrieves turns", async () => {
    const turns: MemoryTurn[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" }
    ];

    for (const turn of turns) {
      await memory.append(SESSION_ID, turn);
    }

    const result = await memory.getContext(SESSION_ID);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("hello");
    expect(result[1].content).toBe("hi there");
    expect(result.every((turn) => typeof turn.tokens === "number")).toBe(true);
  });

  it("enforces max tokens budget when building context", async () => {
    await memory.append(SESSION_ID, { role: "user", content: "short" });
    await memory.append(SESSION_ID, { role: "assistant", content: "this response is going to be quite a bit longer than the budget allows" });

    const context = await memory.getContext(SESSION_ID, { maxTokens: 4 });
    expect(context).toHaveLength(1);
    expect(context[0].role).toBe("assistant");
    expect(typeof context[0].content).toBe("string");
    expect((context[0].content as string).endsWith("…")).toBe(true);
    expect((context[0].tokens ?? 0)).toBeLessThanOrEqual(4);
  });

  it("respects max turn limit", async () => {
    await memory.append(SESSION_ID, { role: "user", content: "turn 1" });
    await memory.append(SESSION_ID, { role: "assistant", content: "turn 2" });
    await memory.append(SESSION_ID, { role: "user", content: "turn 3" });

    const context = await memory.getContext(SESSION_ID, { maxTurns: 2 });
    expect(context).toHaveLength(2);
    expect(context.map((turn) => turn.content)).toEqual(["turn 2", "turn 3"]);
  });

  it("summarizes older turns while keeping recent ones", async () => {
    memory = new InMemoryMemoryManager({ summaryMaxRecentTurns: 2 });

    await memory.append(SESSION_ID, { role: "user", content: "turn 1" });
    await memory.append(SESSION_ID, { role: "assistant", content: "turn 2" });
    await memory.append(SESSION_ID, { role: "user", content: "turn 3" });
    await memory.append(SESSION_ID, { role: "assistant", content: "turn 4" });

    await memory.summarize(SESSION_ID);
    const context = await memory.getContext(SESSION_ID);

    expect(context).toHaveLength(3);
    expect(context[0].role).toBe("summary");
    expect(context[1].content).toBe("turn 3");
    expect(context[2].content).toBe("turn 4");
  });

  it("trims history according to retainTurns option", async () => {
    memory = new InMemoryMemoryManager({ maxTurns: 5 });

    for (let i = 0; i < 6; i += 1) {
      await memory.append(SESSION_ID, { role: "user", content: `turn ${i}` });
    }

    await memory.trim(SESSION_ID, { retainTurns: 3 });
    const context = await memory.getContext(SESSION_ID);

    expect(context).toHaveLength(3);
    expect(context.map((turn) => turn.content)).toEqual(["turn 3", "turn 4", "turn 5"]);
  });

  it("allows custom token counter", async () => {
    const tokenCounter = new BasicTokenCounter();
    memory = new InMemoryMemoryManager({ tokenCounter });

    await memory.append(SESSION_ID, { role: "user", content: "one two three" });
    const [turn] = await memory.getContext(SESSION_ID);

    expect(turn.tokens).toBe(tokenCounter.count("one two three"));
  });
});

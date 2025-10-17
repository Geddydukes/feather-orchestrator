import { describe, expect, it } from "vitest";
import { ContextBuilder } from "../../src/agent/context-builder.js";
import type { AgentMemoryTurn } from "../../src/agent/types.js";

function createTurn(message: { role: "user" | "assistant"; content: string }): AgentMemoryTurn {
  return {
    role: message.role,
    content: { role: message.role, content: message.content },
    createdAt: new Date()
  } as AgentMemoryTurn;
}

describe("ContextBuilder", () => {
  it("orders base, digest, rag, and recent messages", () => {
    const builder = new ContextBuilder({ maxRecentTurns: 2 });
    const history: AgentMemoryTurn[] = [
      createTurn({ role: "user", content: "hello" }),
      createTurn({ role: "assistant", content: "hi" }),
      createTurn({ role: "user", content: "how are you" })
    ];

    const result = builder.build({
      history,
      baseMessages: [{ role: "system", content: "base" }],
      ragMessages: [{ role: "system", content: "rag" }],
      digests: [{ content: "summary" }],
      maxTokens: 100
    });

    expect(result.map((message) => message.content)).toEqual([
      "base",
      "summary",
      "rag",
      "hi",
      "how are you"
    ]);
  });

  it("creates a digest for older history when none is provided", () => {
    const builder = new ContextBuilder({ maxRecentTurns: 2 });
    const history: AgentMemoryTurn[] = [
      createTurn({ role: "user", content: "turn one" }),
      createTurn({ role: "assistant", content: "turn two" }),
      createTurn({ role: "user", content: "turn three" }),
      createTurn({ role: "assistant", content: "turn four" })
    ];

    const result = builder.build({ history, maxTokens: 100 });

    expect(result[0].role).toBe("system");
    expect(result[0].content).toContain("[user] turn one");
    expect(result[0].content).toContain("[assistant] turn two");
    expect(result.slice(1).map((message) => message.content)).toEqual([
      "turn three",
      "turn four"
    ]);
  });

  it("drops RAG messages, then digest, then oldest recents to satisfy budget", () => {
    const builder = new ContextBuilder({ maxRecentTurns: 3 });
    const history: AgentMemoryTurn[] = [
      createTurn({ role: "assistant", content: "first recent" }),
      createTurn({ role: "user", content: "second recent" }),
      createTurn({ role: "assistant", content: "third recent" })
    ];

    const result = builder.build({
      history,
      baseMessages: [{ role: "system", content: "base message" }],
      ragMessages: [
        { role: "system", content: "rag snippet" },
        { role: "system", content: "rag extra" }
      ],
      digests: [{ content: "digest content that should be trimmed" }],
      maxTokens: 7
    });

    expect(result.map((message) => message.content)).toEqual([
      "base message",
      "second recent",
      "third recent"
    ]);
  });

  it("truncates digest content before dropping recent turns", () => {
    const builder = new ContextBuilder({ maxRecentTurns: 2 });
    const history: AgentMemoryTurn[] = [
      createTurn({ role: "assistant", content: "recent one" }),
      createTurn({ role: "user", content: "recent two" })
    ];

    const result = builder.build({
      history,
      baseMessages: [{ role: "system", content: "base" }],
      digests: [{ content: "digest words extra details" }],
      maxTokens: 5
    });

    expect(typeof result[1].content).toBe("string");
    const digestContent = result[1].content as string;
    expect(digestContent).toMatch(/^digest(\s|$)/);
    expect(digestContent.split(/\s+/u).length).toBeLessThanOrEqual(3);
    expect(result.map((message) => message.content)).toEqual([
      result[0].content,
      result[1].content,
      "recent one",
      "recent two"
    ]);
  });
});

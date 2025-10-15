
import { describe, it, expect } from "vitest";
import { Feather } from "../src/core/Orchestrator.js";
import type { ChatProvider } from "../src/providers/base.js";
import type { ChatRequest, ChatResponse } from "../src/types.js";

function mockProvider(id: string, behavior: "ok" | "fail"): ChatProvider {
  return {
    id,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      if (behavior === "fail") throw new Error("fail");
      return { content: "ok" };
    }
  };
}

describe("Feather", () => {
  it("fallback works", async () => {
    const f = new Feather({
      providers: {
        bad: mockProvider("bad", "fail"),
        good: mockProvider("good", "ok"),
      }
    });
    const chain = f.fallback([{ provider: "bad", model: "x" }, { provider: "good", model: "y" }]);
    const res = await chain.chat({ messages: [{ role: "user", content: "hi" }] } as any);
    expect(res.content).toBe("ok");
  });

  it("race works", async () => {
    const slow = (delay: number): ChatProvider => ({
      id: "slow",
      async chat(): Promise<ChatResponse> {
        await new Promise(r => setTimeout(r, delay));
        return { content: String(delay) };
      }
    });
    const f = new Feather({ providers: { a: slow(50), b: slow(10) } });
    const r = await f.race([{ provider: "a", model: "x" }, { provider: "b", model: "y" }]).chat({ messages: [{ role: "user", content: "test" }] } as any);
    expect(r.content).toBe("10");
  });
});

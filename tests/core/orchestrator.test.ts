import { describe, expect, it } from "vitest";
import { Feather } from "../../src/core/Orchestrator.js";
import type { ChatProvider } from "../../src/providers/base.js";
import type { CallOpts, ChatRequest, ChatResponse } from "../../src/types.js";

class StubProvider implements ChatProvider {
  public readonly id: string;
  public aborted = false;
  public calls = 0;

  constructor(
    id: string,
    private readonly delayMs: number,
    private readonly options: { result: string; cost?: number; fail?: boolean } = { result: "" }
  ) {
    this.id = id;
  }

  async chat(_req: ChatRequest, opts?: CallOpts): Promise<ChatResponse> {
    this.calls += 1;
    return await new Promise<ChatResponse>((resolve, reject) => {
      const cleanup = () => {
        opts?.signal?.removeEventListener("abort", onAbort);
      };

      const onAbort = () => {
        this.aborted = true;
        clearTimeout(timer);
        cleanup();
        const error = new Error("Aborted");
        error.name = "AbortError";
        reject(error);
      };

      if (opts?.signal) {
        if (opts.signal.aborted) {
          onAbort();
          return;
        }
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      const timer = setTimeout(() => {
        cleanup();
        if (this.options.fail) {
          reject(new Error(`${this.id} failed`));
          return;
        }
        resolve({ content: this.options.result, costUSD: this.options.cost ?? 0 });
      }, this.delayMs);
    });
  }
}

describe("Feather.race", () => {
  it("returns the first successful response and cancels remaining providers", async () => {
    const fast = new StubProvider("fast", 10, { result: "fast", cost: 0.1 });
    const slow = new StubProvider("slow", 50, { result: "slow", cost: 0.3 });
    const orchestrator = new Feather({ providers: { fast, slow } });

    const response = await orchestrator
      .race([
        { provider: "fast", model: "gpt-test" },
        { provider: "slow", model: "gpt-test" }
      ])
      .chat({ messages: [{ role: "user", content: "hello" }] });

    expect(response.content).toBe("fast");
    expect(slow.aborted).toBe(true);
    expect(fast.aborted).toBe(false);
    expect(orchestrator.totalCostUSD).toBeCloseTo(0.1);
  });

  it("propagates caller aborts to all providers", async () => {
    const slow = new StubProvider("slow", 100, { result: "slow" });
    const slower = new StubProvider("slower", 120, { result: "slower" });
    const orchestrator = new Feather({ providers: { slow, slower } });

    const controller = new AbortController();
    const racePromise = orchestrator
      .race([
        { provider: "slow", model: "gpt-test" },
        { provider: "slower", model: "gpt-test" }
      ])
      .chat({ messages: [{ role: "user", content: "abort" }], signal: controller.signal });

    setTimeout(() => controller.abort(), 5);

    await expect(racePromise).rejects.toMatchObject({ name: "AbortError" });
    expect(slow.aborted).toBe(true);
    expect(slower.aborted).toBe(true);
  });

  it("rejects with an aggregate error when all providers fail", async () => {
    const failingA = new StubProvider("failA", 5, { result: "", fail: true });
    const failingB = new StubProvider("failB", 5, { result: "", fail: true });
    const orchestrator = new Feather({ providers: { failA: failingA, failB: failingB } });

    await expect(
      orchestrator
        .race([
          { provider: "failA", model: "gpt-test" },
          { provider: "failB", model: "gpt-test" }
        ])
        .chat({ messages: [{ role: "user", content: "oops" }] })
    ).rejects.toSatisfy((error: unknown) => error instanceof AggregateError && error.errors.length === 2);

    expect(orchestrator.totalCostUSD).toBe(0);
  });
});

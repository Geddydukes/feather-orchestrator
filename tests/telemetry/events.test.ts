import { describe, expect, it } from "vitest";
import type { AgentAssistantMessage, AgentPlan, AgentUserMessage } from "../../src/agent/types.js";
import { AgentError } from "../../src/agent/types.js";
import type { MemoryManager, MemoryTrimOptions, MemoryTurn } from "../../src/memory/types.js";
import {
  createAgentRunTracker,
  createNdjsonTraceSink,
  withMemoryEventing,
} from "../../src/telemetry/events.js";

describe("withMemoryEventing", () => {
  it("emits memory lifecycle events", async () => {
    const events: string[] = [];
    const baseMemory: MemoryManager<MemoryTurn> = {
      async append() {
        events.push("append");
      },
      async getContext() {
        return [];
      },
      async summarize() {
        events.push("summarize");
      },
      async trim(_sessionId: string, options: MemoryTrimOptions = {}) {
        events.push(`trim:${options.retainTurns ?? ""}`);
      },
    };

    const emitted: string[] = [];
    const instrumented = withMemoryEventing(baseMemory, {
      agentId: "agent-1",
      emit: (event) => emitted.push(event.type),
    });

    await instrumented.append("session", { role: "user", content: "hi" });
    await instrumented.getContext("session");
    await instrumented.summarize?.("session");
    await instrumented.trim?.("session", { retainTurns: 5 });

    expect(events).toEqual(["append", "summarize", "trim:5"]);
    expect(emitted).toEqual([
      "agent.memory.append",
      "agent.memory.summarize",
      "agent.memory.trim",
    ]);
  });
});

describe("createAgentRunTracker", () => {
  const sessionId = "session-1";
  const agentId = "agent-123";
  const plan: AgentPlan = { actions: [{ tool: "calc", input: { expression: "1+1" } }] };
  const userMessage: AgentUserMessage = { role: "user", content: "hello" };
  const assistantMessage: AgentAssistantMessage = { role: "assistant", content: "done" };

  it("aggregates metrics and returns completed snapshot", () => {
    const tracker = createAgentRunTracker({ storeEvents: true });
    const baseTime = new Date("2024-01-01T00:00:00.000Z");

    tracker.handle(
      {
        type: "agent.run.start",
        sessionId,
        input: userMessage,
        metadata: { foo: "bar" },
        agentId,
      },
      baseTime,
    );

    tracker.handle(
      {
        type: "agent.step.start",
        sessionId,
        iteration: 0,
        contextTurns: 2,
        contextTokens: 42,
        startedAt: baseTime,
        agentId,
      },
      baseTime,
    );

    tracker.handle(
      {
        type: "agent.plan",
        sessionId,
        iteration: 0,
        plan,
        durationMs: 25,
        usage: { promptTokens: 15, totalTokens: 15 },
        agentId,
      },
      new Date(baseTime.getTime() + 5),
    );

    tracker.handle(
      {
        type: "agent.tool.start",
        sessionId,
        iteration: 0,
        action: plan.actions[0],
        tool: "calc",
        cached: false,
        agentId,
      },
      new Date(baseTime.getTime() + 10),
    );

    tracker.handle(
      {
        type: "agent.tool.end",
        sessionId,
        iteration: 0,
        action: plan.actions[0],
        tool: "calc",
        result: 2,
        durationMs: 40,
        cached: true,
        agentId,
      },
      new Date(baseTime.getTime() + 50),
    );

    tracker.handle(
      {
        type: "agent.step.done",
        sessionId,
        iteration: 0,
        status: "continue",
        durationMs: 80,
        contextTurns: 2,
        contextTokens: 42,
        plan,
        actions: [
          {
            tool: "calc",
            input: plan.actions[0].input,
            result: 2,
            startedAt: baseTime,
            finishedAt: new Date(baseTime.getTime() + 50),
            durationMs: 40,
            cacheHit: true,
          },
        ],
        agentId,
      },
      new Date(baseTime.getTime() + 90),
    );

    tracker.handle(
      {
        type: "agent.memory.append",
        sessionId,
        turn: { role: "assistant", content: assistantMessage },
        agentId,
      },
      new Date(baseTime.getTime() + 95),
    );

    const snapshot = tracker.handle(
      {
        type: "agent.run.complete",
        sessionId,
        output: assistantMessage,
        steps: [],
        iterationCount: 1,
        elapsedMs: 120,
        agentId,
      },
      new Date(baseTime.getTime() + 120),
    );

    expect(snapshot).toBeDefined();
    expect(snapshot?.status).toBe("completed");
    expect(snapshot?.metrics.toolCalls).toBe(1);
    expect(snapshot?.metrics.toolCacheHits).toBe(1);
    expect(snapshot?.metrics.toolDurationMs).toBe(40);
    expect(snapshot?.metrics.planDurationMs).toBe(25);
    expect(snapshot?.metrics.contextTokensTotal).toBe(42);
    expect(snapshot?.metrics.promptTokens).toBe(15);
    expect(snapshot?.metrics.totalTokens).toBe(15);
    expect(snapshot?.metrics.memoryAppends).toBe(1);
    expect(snapshot?.metrics.stepErrors).toBe(0);
    expect(snapshot?.result).toEqual({ type: "completed", output: assistantMessage });
    expect(snapshot?.events.length).toBeGreaterThan(0);
  });

  it("captures error steps and propagates agent errors", () => {
    const tracker = createAgentRunTracker();

    tracker.handle({
      type: "agent.run.start",
      sessionId,
      input: userMessage,
    });

    tracker.handle({
      type: "agent.step.start",
      sessionId,
      iteration: 0,
      contextTurns: 1,
      startedAt: new Date(),
    });

    tracker.handle({
      type: "agent.step.done",
      sessionId,
      iteration: 0,
      status: "error",
      durationMs: 10,
      contextTurns: 1,
      error: new AgentError("UNEXPECTED_ERROR", "boom"),
    });

    const snapshot = tracker.handle({
      type: "agent.run.error",
      sessionId,
      error: new AgentError("UNEXPECTED_ERROR", "failed"),
      steps: [],
      iterationCount: 1,
      elapsedMs: 11,
    });

    expect(snapshot?.status).toBe("error");
    expect(snapshot?.metrics.stepErrors).toBe(1);
    expect(snapshot?.result?.type).toBe("error");
  });
});

describe("createNdjsonTraceSink", () => {
  it("writes events and summaries", () => {
    const lines: string[] = [];
    const sink = createNdjsonTraceSink({
      writer: { write: (line: string) => lines.push(line.trim()) },
    });

    const sessionId = "ndjson-session";
    const output: AgentAssistantMessage = { role: "assistant", content: "ok" };

    sink({
      type: "agent.run.start",
      sessionId,
      input: { role: "user", content: "hello" },
    });

    sink({
      type: "agent.run.complete",
      sessionId,
      output,
      steps: [],
      iterationCount: 0,
      elapsedMs: 10,
    });

    expect(lines.length).toBe(3);
    const parsedEvents = lines.map((line) => JSON.parse(line));
    expect(parsedEvents[0].type).toBe("agent.run.start");
    expect(parsedEvents[1].type).toBe("agent.run.complete");
    expect(parsedEvents[2].type).toBe("agent.run.summary");
    expect(parsedEvents[2].metrics.iterationCount).toBe(0);
  });
});

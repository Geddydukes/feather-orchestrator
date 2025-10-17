import { describe, expect, it, vi } from "vitest";
import { createJsonPlanner, PlannerOutputParseError } from "../../src/agent/planner.js";
import { isFinalPlan } from "../../src/agent/plan.js";
import type { AgentMemoryTurn, AgentPlan, AgentToolMessage } from "../../src/agent/types.js";
import type { Message } from "../../src/types.js";

function buildTurn(turn: AgentMemoryTurn): AgentMemoryTurn {
  return { ...turn, createdAt: turn.createdAt ?? new Date() };
}

describe("createJsonPlanner", () => {
  it("constructs a plan with tool actions", async () => {
    const callModel = vi.fn(async () => JSON.stringify({ actions: [{ tool: "calc", input: { expression: "2+2" } }] }));
    const planner = createJsonPlanner({
      callModel,
      tools: [{ name: "calc", description: "Deterministic calculator" }],
    });

    const plan = await planner({
      sessionId: "s1",
      input: { role: "user", content: "Compute" },
      context: [buildTurn({ role: "user", content: { role: "user", content: "Compute" } })],
      iteration: 0,
      metadata: { traceId: "123" },
      signal: undefined,
    });

    expect(plan).toEqual({ actions: [{ tool: "calc", input: { expression: "2+2" } }] });
    expect(callModel).toHaveBeenCalledTimes(1);
    const [{ messages, metadata }] = callModel.mock.calls[0];
    expect(messages[0].role).toBe("system");
    expect(messages[1].content).toContain("Tools you may call");
    expect(messages[messages.length - 1]).toEqual({ role: "user", content: "Compute" });
    expect(metadata).toEqual({ traceId: "123" });
  });

  it("parses JSON contained within code fences", async () => {
    const callModel = vi.fn(async () => "```json\n{\n  \"final\": { \"role\": \"assistant\", \"content\": \"done\" }\n}\n```");
    const planner = createJsonPlanner({ callModel, tools: [] });

    const plan = await planner({
      sessionId: "s2",
      input: { role: "user", content: "hi" },
      context: [buildTurn({ role: "user", content: { role: "user", content: "hi" } })],
      iteration: 1,
      metadata: undefined,
      signal: undefined,
    });

    const agentPlan = plan as AgentPlan;
    if (!isFinalPlan(agentPlan)) {
      throw new Error("Expected planner to return a final message");
    }
    expect(agentPlan.final.content).toBe("done");
  });

  it("invokes the fallback when parsing fails", async () => {
    const callModel = vi.fn(async () => "not json");
    const fallback = vi.fn(() => ({
      final: { role: "assistant", content: "Unable to plan" },
    }));
    const onError = vi.fn();
    const planner = createJsonPlanner({ callModel, tools: [], fallback, onError });

    const plan = await planner({
      sessionId: "s3",
      input: { role: "user", content: "status" },
      context: [buildTurn({ role: "user", content: { role: "user", content: "status" } })],
      iteration: 2,
      metadata: undefined,
      signal: undefined,
    });

    const agentPlan = plan as AgentPlan;
    if (!isFinalPlan(agentPlan)) {
      throw new Error("Expected fallback to return a final plan");
    }
    expect(agentPlan.final.content).toBe("Unable to plan");
    expect(fallback).toHaveBeenCalledTimes(1);
    const [[fallbackContext]] = fallback.mock.calls;
    expect(fallbackContext.error).toBeInstanceOf(PlannerOutputParseError);
    expect(onError).toHaveBeenCalledWith(expect.any(PlannerOutputParseError), expect.objectContaining({ sessionId: "s3" }));
  });

  it("formats tool turns into planner messages", async () => {
    const toolMessage: AgentToolMessage = { role: "tool", name: "lookup", content: { value: 42 } };
    const callModel = vi.fn(async () => JSON.stringify({ final: { role: "assistant", content: "done" } }));
    const planner = createJsonPlanner({ callModel, tools: [{ name: "lookup", description: "Lookup" }] });

    await planner({
      sessionId: "s4",
      input: { role: "user", content: "next" },
      context: [
        buildTurn({ role: "user", content: { role: "user", content: "question" } }),
        buildTurn({ role: "tool", content: toolMessage }),
        buildTurn({ role: "user", content: { role: "user", content: "next" } }),
      ],
      iteration: 3,
      metadata: undefined,
      signal: undefined,
    });

    const [{ messages }] = callModel.mock.calls.slice(-1);
    const toolMessages = messages.filter((msg: Message) => msg.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].content).toContain("lookup");
    expect(toolMessages[0].content).toContain("42");
  });
});

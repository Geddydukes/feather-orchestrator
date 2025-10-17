import { describe, expect, it, vi } from "vitest";
import { Agent } from "../../src/agent/Agent.js";
import { ToolCache } from "../../src/core/tool-cache.js";
import type {
  AgentAssistantMessage,
  AgentMemoryTurn,
  AgentMessage,
  AgentPlanAction,
  AgentPlannerResult,
  AgentRunFailure,
  AgentRunSuccess,
  AgentToolMessage,
  PlannerContext
} from "../../src/agent/types.js";
import type { MemoryGetContextOptions, MemoryManager } from "../../src/memory/types.js";
import type { Tool } from "../../src/tools/types.js";

class TestMemory implements MemoryManager<AgentMemoryTurn> {
  private readonly store = new Map<string, AgentMemoryTurn[]>();

  async append(sessionId: string, turn: AgentMemoryTurn): Promise<void> {
    const history = this.store.get(sessionId) ?? [];
    history.push({
      ...turn,
      createdAt: turn.createdAt ?? new Date()
    });
    this.store.set(sessionId, history);
  }

  async getContext(sessionId: string, options?: MemoryGetContextOptions): Promise<AgentMemoryTurn[]> {
    const history = this.store.get(sessionId) ?? [];
    if (!options?.maxTurns) {
      return [...history];
    }
    return history.slice(-Math.max(options.maxTurns, 0));
  }

  snapshot(sessionId: string): AgentMemoryTurn[] {
    return [...(this.store.get(sessionId) ?? [])];
  }
}

describe("Agent", () => {
  it("executes plan→act→final loops and persists turns", async () => {
    const memory = new TestMemory();
    const echoTool: Tool<{ text: string }, string> = {
      name: "echo",
      description: "Echoes the provided text",
      run: async ({ text }) => text
    };

    const planner = async ({ context }: PlannerContext): Promise<AgentPlannerResult> => {
      const lastToolTurn = [...context].reverse().find((turn) => turn.role === "tool");
      if (!lastToolTurn) {
        const action: AgentPlanAction = { tool: "echo", input: { text: "hello" } };
        return { actions: [action] };
      }
      const toolMessage = lastToolTurn.content as AgentToolMessage;
      const final: AgentAssistantMessage = {
        role: "assistant",
        content: `Tool responded with: ${toolMessage.content}`
      };
      return { final };
    };

    const agent = new Agent({
      id: "test-agent",
      planner,
      memory,
      tools: [echoTool]
    });

    const result = await agent.run({
      sessionId: "session-1",
      input: { role: "user", content: "hi" }
    });

    expect(result.status).toBe("completed");
    const success = result as AgentRunSuccess;
    expect(success.output.content).toBe("Tool responded with: hello");
    expect(success.steps).toHaveLength(2);
    expect(success.steps[0].actions).toHaveLength(1);
    expect(success.steps[0].actions[0].result).toBe("hello");
    expect(success.steps[0].actions[0].cacheHit).toBe(false);

    const history = memory.snapshot("session-1");
    expect(history.map((turn) => turn.role)).toEqual(["user", "tool", "assistant"]);
  });

  it("returns structured errors when planner references unknown tools", async () => {
    const memory = new TestMemory();
    const agent = new Agent({
      planner: async () => ({ actions: [{ tool: "missing", input: {} }] }),
      memory,
      tools: []
    });

    const result = await agent.run({
      sessionId: "session-2",
      input: { role: "user", content: "test" }
    });

    expect(result.status).toBe("error");
    const failure = result as AgentRunFailure;
    expect(failure.error.code).toBe("UNKNOWN_TOOL");
    expect(failure.steps).toHaveLength(1);
    expect(failure.steps[0].plan).toEqual({ actions: [{ tool: "missing", input: {} }] });
  });

  it("enforces the max iteration budget", async () => {
    const memory = new TestMemory();
    const counterTool: Tool<{ value: number }, { value: number }> = {
      name: "counter",
      description: "increments a counter",
      run: async (args: { value: number }) => ({ value: args.value + 1 })
    };

    let counter = 0;
    const planner = async () => {
      counter += 1;
      return { actions: [{ tool: "counter", input: { value: counter } }] };
    };

    const agent = new Agent({
      planner,
      memory,
      tools: [counterTool],
      maxIterations: 1
    });

    const result = await agent.run({
      sessionId: "session-3",
      input: { role: "user", content: "loop" }
    });

    expect(result.status).toBe("error");
    const failure = result as AgentRunFailure;
    expect(failure.error.code).toBe("MAX_ITERATIONS_EXCEEDED");
    expect(failure.steps).toHaveLength(1);
  });

  it("builds planner prompts with context builder budgets", async () => {
    const memory = new TestMemory();
    const sessionId = "session-context";
    const previousAssistant: AgentAssistantMessage = { role: "assistant", content: "Older answer" };
    await memory.append(sessionId, { role: previousAssistant.role, content: previousAssistant });
    await memory.append(sessionId, { role: "user", content: { role: "user", content: "Older question" } });

    let capturedPrompt: readonly AgentMessage[] | undefined;
    const planner = vi.fn(async ({ prompt }: PlannerContext) => {
      capturedPrompt = prompt;
      const final: AgentAssistantMessage = { role: "assistant", content: "ack" };
      return { final };
    });

    const agent = new Agent({
      planner,
      memory,
      tools: [],
      context: { maxRecentTurns: 1 }
    });

    const result = await agent.run({
      sessionId,
      input: { role: "user", content: "Latest question" },
      context: { maxTokens: 200, maxRecentTurns: 1 }
    });

    expect(result.status).toBe("completed");
    expect(planner).toHaveBeenCalledTimes(1);
    expect(capturedPrompt).toBeDefined();
    expect(capturedPrompt?.length).toBe(2);
    expect(capturedPrompt?.[0].role).toBe("system");
    expect(capturedPrompt?.[0].content).toContain("[assistant]");
    expect(capturedPrompt?.[1]).toEqual({ role: "user", content: "Latest question" });
  });

  it("serves cached tool results when configured", async () => {
    const memory = new TestMemory();
    const runSpy = vi.fn(async ({ value }: { value: number }) => ({ doubled: value * 2 }));
    const expensiveTool: Tool<{ value: number }, { doubled: number }> = {
      name: "expensive",
      description: "Double a value",
      cacheTtlSec: 120,
      run: runSpy
    };

    const planner = async (): Promise<AgentPlannerResult> => ({
      actions: [
        { tool: "expensive", input: { value: 2 } },
        { tool: "expensive", input: { value: 2 } }
      ]
    });

    const agent = new Agent({
      planner,
      memory,
      tools: [expensiveTool],
      toolCache: new ToolCache()
    });

    const result = await agent.run({
      sessionId: "cache", 
      input: { role: "user", content: "compute" }
    });

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("completed");
    const success = result as AgentRunSuccess;
    expect(success.steps[0].actions).toHaveLength(2);
    expect(success.steps[0].actions[0].cacheHit).toBe(false);
    expect(success.steps[0].actions[1].cacheHit).toBe(true);
    expect(success.steps[0].actions[0].result).toEqual({ doubled: 4 });
    expect(success.steps[0].actions[1].result).toEqual({ doubled: 4 });
  });

  it("stops when the planner repeats the same action plan", async () => {
    const memory = new TestMemory();
    const runSpy = vi.fn(async () => "result");
    const noopTool: Tool<{ value: number }, string> = {
      name: "noop",
      description: "Returns a canned value",
      run: runSpy,
    };

    const planner = vi.fn((): AgentPlannerResult => ({
      actions: [{ tool: "noop", input: { value: 1 } }],
    }));

    const agent = new Agent({
      planner,
      memory,
      tools: [noopTool],
    });

    const result = await agent.run({
      sessionId: "loop-guard",
      input: { role: "user", content: "start" },
    });

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(planner).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("completed");
    const success = result as AgentRunSuccess;
    expect(success.steps).toHaveLength(2);
    expect(success.steps[1].actions).toHaveLength(0);
    expect(success.output.content).toContain("repeated the same plan");
  });

  it("respects a shouldStop callback before executing new actions", async () => {
    const memory = new TestMemory();
    const runSpy = vi.fn(async () => "done");
    const repeatTool: Tool<{ value: number }, string> = {
      name: "repeat",
      description: "Returns done",
      run: runSpy,
    };

    const planner = vi.fn(({ iteration }: PlannerContext): AgentPlannerResult => ({
      actions: [{ tool: "repeat", input: { value: iteration } }],
    }));

    const shouldStop = vi.fn(async ({ iteration }: { iteration: number }) =>
      iteration >= 1 ? { message: "Stopping from callback" } : false
    );

    const agent = new Agent({
      planner,
      memory,
      tools: [repeatTool],
    });

    const result = await agent.run({
      sessionId: "stop-hook",
      input: { role: "user", content: "go" },
      shouldStop,
    });

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(shouldStop).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("completed");
    const success = result as AgentRunSuccess;
    expect(success.steps).toHaveLength(2);
    expect(success.steps[1].actions).toHaveLength(0);
    expect(success.output.content).toContain("Stopping from callback");
    const historyRoles = memory.snapshot("stop-hook").map((turn) => turn.role);
    expect(historyRoles).toEqual(["user", "tool", "assistant"]);
  });
});

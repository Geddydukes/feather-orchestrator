import { describe, expect, it } from "vitest";
import { Agent } from "../../src/agent/Agent.js";
import { createPolicyManager } from "../../src/agent/policies.js";
import { createQuotaManager } from "../../src/agent/quotas.js";
import type {
  AgentAssistantMessage,
  AgentMemoryTurn,
  AgentPlanAction,
  AgentPlannerResult,
  AgentRunFailure,
  AgentRunSuccess,
  AgentToolMessage,
  PlannerContext
} from "../../src/agent/types.js";
import type { MemoryGetContextOptions, MemoryManager } from "../../src/memory/types.js";
import type { Tool } from "../../src/tools/types.js";
import { z } from "zod";

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

describe("Agent guardrails", () => {
  it("blocks tools not permitted by policy", async () => {
    const memory = new TestMemory();
    const safeTool: Tool = {
      name: "safe",
      description: "Safe tool",
      run: async () => "ok"
    };
    const riskyTool: Tool = {
      name: "risky",
      description: "Risky tool",
      run: async () => "danger"
    };

    const agent = new Agent({
      planner: async (): Promise<AgentPlannerResult> => ({
        actions: [{ tool: "risky", input: {} }]
      }),
      memory,
      tools: [safeTool, riskyTool],
      policies: createPolicyManager({ allowedTools: ["safe"] })
    });

    const result = await agent.run({
      sessionId: "policy-block", 
      input: { role: "user", content: "test" }
    });

    expect(result.status).toBe("error");
    const failure = result as AgentRunFailure;
    expect(failure.error.code).toBe("TOOL_NOT_ALLOWED");
  });

  it("validates tool inputs using schemas", async () => {
    const memory = new TestMemory();
    const echoTool: Tool<{ value: number }, number> = {
      name: "echo",
      description: "Echoes numbers",
      run: async ({ value }) => value
    };

    const agent = new Agent({
      planner: async (): Promise<AgentPlannerResult> => ({
        actions: [{ tool: "echo", input: { value: "oops" } }]
      }),
      memory,
      tools: [echoTool],
      policies: createPolicyManager({
        allowedTools: ["echo"],
        toolPolicies: [
          {
            tool: "echo",
            schema: z.object({ value: z.number() })
          }
        ]
      })
    });

    const result = await agent.run({
      sessionId: "schema-fail",
      input: { role: "user", content: "validate" }
    });

    expect(result.status).toBe("error");
    const failure = result as AgentRunFailure;
    expect(failure.error.code).toBe("TOOL_VALIDATION_FAILED");
  });

  it("redacts tool inputs and outputs while keeping tool execution intact", async () => {
    const memory = new TestMemory();
    const capturedInputs: unknown[] = [];
    const secretTool: Tool<{ secret: string }, { secret: string }> = {
      name: "secret",
      description: "Handles secrets",
      run: async (args) => {
        capturedInputs.push(args);
        return { secret: args.secret };
      }
    };

    let toolInvoked = false;
    const planner = async ({ context }: PlannerContext): Promise<AgentPlannerResult> => {
      const lastTool = [...context].reverse().find((turn) => turn.role === "tool");
      if (lastTool) {
        const toolMessage = lastTool.content as AgentToolMessage;
        const final: AgentAssistantMessage = {
          role: "assistant",
          content: `Seen: ${JSON.stringify(toolMessage.content)}`
        };
        return { final };
      }
      toolInvoked = true;
      const action: AgentPlanAction = { tool: "secret", input: { secret: "token-123" } };
      return { actions: [action] };
    };

    const agent = new Agent({
      planner,
      memory,
      tools: [secretTool],
      policies: createPolicyManager({
        allowedTools: ["secret"],
        toolPolicies: [
          {
            tool: "secret",
            schema: z.object({ secret: z.string() }),
            redactInput: () => ({ secret: "[redacted]" }),
            redactResult: () => ({ secret: "[sanitized]" })
          }
        ]
      })
    });

    const result = await agent.run({
      sessionId: "redact",
      input: { role: "user", content: "mask it" }
    });

    expect(toolInvoked).toBe(true);
    expect(capturedInputs).toEqual([{ secret: "token-123" }]);
    expect(result.status).toBe("completed");
    const success = result as AgentRunSuccess;
    expect(success.steps[0].actions[0].input).toEqual({ secret: "[redacted]" });
    expect(success.steps[0].actions[0].result).toEqual({ secret: "[sanitized]" });
    expect(success.steps[0].actions[0].cacheHit).toBe(false);

    const toolTurns = memory
      .snapshot("redact")
      .filter((turn) => turn.role === "tool")
      .map((turn) => (turn.content as AgentToolMessage).content);
    expect(toolTurns).toEqual([{ secret: "[sanitized]" }]);
  });

  it("produces audit payloads when configured", async () => {
    const memory = new TestMemory();
    const tool: Tool = {
      name: "audited",
      description: "Audited tool",
      run: async () => ({ token: "abcd-1234" })
    };

    const auditEvents: unknown[] = [];
    const expectedHash = JSON.stringify({ token: "abcd-1234" }).length;

    const agent = new Agent({
      planner: async ({ context }: PlannerContext): Promise<AgentPlannerResult> => {
        const lastTool = [...context].reverse().find((turn) => turn.role === "tool");
        if (lastTool) {
          const final: AgentAssistantMessage = {
            role: "assistant",
            content: "done"
          };
          return { final };
        }
        return { actions: [{ tool: "audited", input: {} }] };
      },
      memory,
      tools: [tool],
      policies: createPolicyManager({
        allowedTools: ["audited"],
        toolPolicies: [
          {
            tool: "audited",
            audit: (result) => ({ hash: JSON.stringify(result).length })
          }
        ]
      }),
      onEvent: (event) => {
        if (event.type === "agent.tool.end") {
          auditEvents.push(event.audit);
        }
      }
    });

    const result = await agent.run({
      sessionId: "audit", 
      input: { role: "user", content: "go" }
    });

    expect(result.status).toBe("completed");
    const success = result as AgentRunSuccess;
    expect(success.steps[0].actions[0].audit).toEqual({ hash: expectedHash });
    expect(auditEvents).toEqual([{ hash: expectedHash }]);
  });

  it("enforces per-session quotas", async () => {
    const memory = new TestMemory();
    const echoTool: Tool<{ text: string }, string> = {
      name: "echo",
      description: "Echo text",
      run: async ({ text }) => text
    };

    const planner = async (): Promise<AgentPlannerResult> => ({
      actions: [
        { tool: "echo", input: { text: "one" } },
        { tool: "echo", input: { text: "two" } }
      ]
    });

    const agent = new Agent({
      planner,
      memory,
      tools: [echoTool],
      quotas: createQuotaManager({
        rules: [
          {
            name: "per-session",
            limit: 1,
            intervalMs: 60_000,
            scope: "session"
          }
        ]
      })
    });

    const result = await agent.run({
      sessionId: "quota",
      input: { role: "user", content: "go" }
    });

    expect(result.status).toBe("error");
    const failure = result as AgentRunFailure;
    expect(failure.error.code).toBe("QUOTA_EXCEEDED");
    expect(failure.steps[0].actions).toHaveLength(1);

    const toolTurns = memory.snapshot("quota").filter((turn) => turn.role === "tool");
    expect(toolTurns).toHaveLength(1);
  });
});

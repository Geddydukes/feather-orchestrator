import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../src/agent/types.js";
import { createOtelAgentObserver } from "../../src/telemetry/otel.js";

interface RecordedMetric {
  name: string;
  value: number;
  attributes?: Record<string, unknown>;
}

class StubCounter {
  constructor(private readonly name: string, private readonly records: RecordedMetric[]) {}

  add(value: number, attributes?: Record<string, unknown>): void {
    this.records.push({ name: this.name, value, attributes });
  }
}

class StubHistogram {
  constructor(private readonly name: string, private readonly records: RecordedMetric[]) {}

  record(value: number, attributes?: Record<string, unknown>): void {
    this.records.push({ name: this.name, value, attributes });
  }
}

class StubMeter {
  constructor(private readonly records: RecordedMetric[]) {}

  createCounter(name: string, _options?: { description?: string; unit?: string }): StubCounter {
    return new StubCounter(name, this.records);
  }

  createHistogram(name: string, _options?: { description?: string; unit?: string }): StubHistogram {
    return new StubHistogram(name, this.records);
  }
}

describe("createOtelAgentObserver", () => {
  it("records metrics for lifecycle and tool events", () => {
    const records: RecordedMetric[] = [];
    const observer = createOtelAgentObserver({
      meter: new StubMeter(records),
      metricPrefix: "test.agent",
      defaultAttributes: { env: "test" },
    });

    const start: AgentEvent = {
      type: "agent.run.start",
      sessionId: "s",
      input: { role: "user", content: "hi" },
      agentId: "agent",
    };

    const plan: AgentEvent = {
      type: "agent.plan",
      sessionId: "s",
      iteration: 0,
      plan: { actions: [] },
      durationMs: 20,
      usage: { promptTokens: 10, costUsd: 0.02 },
      agentId: "agent",
    };

    const toolEnd: AgentEvent = {
      type: "agent.tool.end",
      sessionId: "s",
      iteration: 0,
      action: { tool: "calc", input: {} },
      tool: "calc",
      result: 2,
      durationMs: 30,
      cached: true,
      usage: { totalTokens: 5 },
      agentId: "agent",
    };

    const done: AgentEvent = {
      type: "agent.step.done",
      sessionId: "s",
      iteration: 0,
      status: "continue",
      durationMs: 50,
      contextTurns: 1,
      agentId: "agent",
    };

    const complete: AgentEvent = {
      type: "agent.run.complete",
      sessionId: "s",
      output: { role: "assistant", content: "done" },
      steps: [],
      iterationCount: 1,
      elapsedMs: 100,
      agentId: "agent",
    };

    observer(start);
    observer(plan);
    observer(toolEnd);
    observer(done);
    observer(complete);

    const names = records.map((entry) => entry.name);
    expect(names).toContain("test.agent.runs");
    expect(names).toContain("test.agent.plan.duration");
    expect(names).toContain("test.agent.tool.duration");
    expect(names).toContain("test.agent.tokens");
    expect(names).toContain("test.agent.run.duration");

    const tokenEntries = records.filter((entry) => entry.name === "test.agent.tokens");
    expect(tokenEntries).toHaveLength(2); // prompt and total segments
    expect(tokenEntries[0].attributes?.segment).toBeDefined();
  });
});

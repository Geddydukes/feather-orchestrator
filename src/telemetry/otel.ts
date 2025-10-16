import type { AgentEvent, TokenUsage } from "../agent/types.js";

export type OtelAttributeValue = string | number | boolean;
export type OtelAttributes = Record<string, OtelAttributeValue>;

export interface OtelCounter {
  add(value: number, attributes?: OtelAttributes): void;
}

export interface OtelHistogram {
  record(value: number, attributes?: OtelAttributes): void;
}

export interface OtelMeter {
  createCounter(name: string, options?: { description?: string; unit?: string }): OtelCounter;
  createHistogram(name: string, options?: { description?: string; unit?: string }): OtelHistogram;
}

export interface OtelAgentObserverOptions {
  meter: OtelMeter;
  metricPrefix?: string;
  defaultAttributes?: OtelAttributes;
}

export function createOtelAgentObserver(options: OtelAgentObserverOptions): (event: AgentEvent) => void {
  const prefix = options.metricPrefix ?? "agent";
  const baseAttributes = options.defaultAttributes ?? {};
  const meter = options.meter;

  const runsCounter = meter.createCounter(`${prefix}.runs`, {
    description: "Count of agent run lifecycle events",
  });
  const runDuration = meter.createHistogram(`${prefix}.run.duration`, {
    description: "Agent run duration",
    unit: "ms",
  });
  const planDuration = meter.createHistogram(`${prefix}.plan.duration`, {
    description: "Planner latency",
    unit: "ms",
  });
  const toolDuration = meter.createHistogram(`${prefix}.tool.duration`, {
    description: "Tool execution latency",
    unit: "ms",
  });
  const stepDuration = meter.createHistogram(`${prefix}.step.duration`, {
    description: "Agent step latency",
    unit: "ms",
  });
  const toolCalls = meter.createCounter(`${prefix}.tool.calls`, {
    description: "Tool invocations",
  });
  const toolErrors = meter.createCounter(`${prefix}.tool.errors`, {
    description: "Tool errors",
  });
  const toolCacheHits = meter.createCounter(`${prefix}.tool.cache_hits`, {
    description: "Tool cache hits",
  });
  const stepErrors = meter.createCounter(`${prefix}.step.errors`, {
    description: "Agent step failures",
  });
  const memoryAppends = meter.createCounter(`${prefix}.memory.appends`, {
    description: "Memory append operations",
  });
  const memorySummaries = meter.createCounter(`${prefix}.memory.summaries`, {
    description: "Memory summarisation operations",
  });
  const memoryTrims = meter.createCounter(`${prefix}.memory.trims`, {
    description: "Memory trim operations",
  });
  const contextTokens = meter.createHistogram(`${prefix}.context.tokens`, {
    description: "Context token usage per step",
    unit: "token",
  });
  const tokenCounter = meter.createCounter(`${prefix}.tokens`, {
    description: "Token usage reported by planner/tools",
    unit: "token",
  });
  const costCounter = meter.createCounter(`${prefix}.cost`, {
    description: "Cost reported by planner/tools",
    unit: "USD",
  });

  const makeAttributes = (event: AgentEvent, extra?: OtelAttributes): OtelAttributes => {
    const attributes: OtelAttributes = { ...baseAttributes, ...(extra ?? {}) };
    if (event.agentId) {
      attributes.agentId = event.agentId;
    }
    return attributes;
  };

  const recordUsage = (event: AgentEvent, usage: TokenUsage | undefined, extra?: OtelAttributes) => {
    if (!usage) {
      return;
    }
    const attributes = makeAttributes(event, extra);
    if (typeof usage.promptTokens === "number") {
      tokenCounter.add(usage.promptTokens, { ...attributes, segment: "prompt" });
    }
    if (typeof usage.completionTokens === "number") {
      tokenCounter.add(usage.completionTokens, { ...attributes, segment: "completion" });
    }
    if (typeof usage.totalTokens === "number") {
      tokenCounter.add(usage.totalTokens, { ...attributes, segment: "total" });
    }
    if (typeof usage.costUsd === "number") {
      costCounter.add(usage.costUsd, attributes);
    }
  };

  return (event: AgentEvent): void => {
    switch (event.type) {
      case "agent.run.start":
        runsCounter.add(1, makeAttributes(event, { phase: "start" }));
        break;
      case "agent.run.complete":
        runsCounter.add(1, makeAttributes(event, { phase: "complete", status: "success" }));
        runDuration.record(event.elapsedMs, makeAttributes(event, { status: "success" }));
        break;
      case "agent.run.error":
        runsCounter.add(1, makeAttributes(event, { phase: "complete", status: "error" }));
        runDuration.record(event.elapsedMs, makeAttributes(event, { status: "error" }));
        break;
      case "agent.plan":
        planDuration.record(event.durationMs, makeAttributes(event));
        recordUsage(event, event.usage, { stage: "plan" });
        break;
      case "agent.tool.start":
        toolCalls.add(1, makeAttributes(event, { tool: event.tool }));
        break;
      case "agent.tool.end":
        toolDuration.record(event.durationMs, makeAttributes(event, { tool: event.tool, cached: Boolean(event.cached) }));
        if (event.cached) {
          toolCacheHits.add(1, makeAttributes(event, { tool: event.tool }));
        }
        recordUsage(event, event.usage, { stage: "tool", tool: event.tool });
        break;
      case "agent.tool.error":
        toolErrors.add(1, makeAttributes(event, { tool: event.tool }));
        toolDuration.record(event.durationMs, makeAttributes(event, { tool: event.tool, error: true }));
        break;
      case "agent.step.start":
        if (typeof event.contextTokens === "number") {
          contextTokens.record(event.contextTokens, makeAttributes(event));
        }
        break;
      case "agent.step.done":
        stepDuration.record(event.durationMs, makeAttributes(event, { status: event.status }));
        if (event.status === "error") {
          stepErrors.add(1, makeAttributes(event, { status: "error" }));
        }
        break;
      case "agent.memory.append":
        memoryAppends.add(1, makeAttributes(event));
        break;
      case "agent.memory.summarize":
        memorySummaries.add(1, makeAttributes(event));
        break;
      case "agent.memory.trim":
        memoryTrims.add(1, makeAttributes(event));
        break;
      default:
        break;
    }
  };
}

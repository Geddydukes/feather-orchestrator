import { Agent } from "../src/agent/Agent.js";
import type { AgentMemoryTurn } from "../src/agent/types.js";
import { InMemoryMemoryManager } from "../src/memory/inmemory.js";
import type { MemoryManager } from "../src/memory/types.js";
import { createNdjsonTraceSink, createAgentRunTracker } from "../src/telemetry/events.js";
import { createOtelAgentObserver, type OtelAttributes, type OtelMeter } from "../src/telemetry/otel.js";

class ConsoleMeter implements OtelMeter {
  createCounter(name: string) {
    return {
      add(value: number, attributes?: OtelAttributes) {
        console.log(`[metric] ${name} add`, value, attributes ?? {});
      },
    };
  }

  createHistogram(name: string) {
    return {
      record(value: number, attributes?: OtelAttributes) {
        console.log(`[metric] ${name} record`, value, attributes ?? {});
      },
    };
  }
}

(async () => {
  const ndjson = createNdjsonTraceSink({ writer: { write: (line: string) => process.stdout.write(line) } });
  const tracker = createAgentRunTracker();
  const meter = new ConsoleMeter();
  const otelObserver = createOtelAgentObserver({ meter, metricPrefix: "demo.agent" });
  const memory = new InMemoryMemoryManager() as unknown as MemoryManager<AgentMemoryTurn>;

  const agent = new Agent({
    id: "observability-demo",
    planner: async () => ({
      final: { role: "assistant", content: "This is a traced response" },
      usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20, costUsd: 0.0016 },
    }),
    memory,
    tools: [],
    onEvent: (event) => {
      const summary = tracker.handle(event);
      ndjson(event);
      otelObserver(event);
      if (summary) {
        console.log("[metrics] run summary", summary.metrics);
      }
    },
  });

  await agent.run({
    sessionId: "demo-session",
    input: { role: "user", content: "Show me observability" },
  });
})();

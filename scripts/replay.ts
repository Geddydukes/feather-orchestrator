#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

function usage() {
  console.error("Usage: scripts/replay.ts <trace.ndjson>");
  process.exit(1);
}

const file = process.argv[2];
if (!file) {
  usage();
}

const stream = createReadStream(file, { encoding: "utf8" });
stream.on("error", (error) => {
  console.error(`Failed to read ${file}:`, error);
  process.exit(1);
});

const rl = createInterface({ input: stream, crlfDelay: Infinity });

const summary = {
  sessionId: undefined as string | undefined,
  agentId: undefined as string | undefined,
  status: "running" as "running" | "completed" | "error",
  steps: 0,
  toolCalls: 0,
  cacheHits: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  durationMs: 0,
};

const timeline: string[] = [];

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  let event: any;
  try {
    event = JSON.parse(trimmed);
  } catch (error) {
    console.warn("Skipping invalid JSON line", error);
    return;
  }
  if (!event || typeof event.type !== "string") {
    return;
  }

  summary.sessionId ??= event.sessionId;
  summary.agentId ??= event.agentId;

  switch (event.type) {
    case "agent.run.start":
      timeline.push(`Run started at ${event.timestamp ?? "unknown"}`);
      break;
    case "agent.plan": {
      if (event.usage) {
        summary.promptTokens += event.usage.promptTokens ?? 0;
        summary.completionTokens += event.usage.completionTokens ?? 0;
        summary.totalTokens += event.usage.totalTokens ?? 0;
        summary.costUsd += event.usage.costUsd ?? 0;
      }
      const planDescription = Array.isArray(event.plan?.actions)
        ? `${event.plan.actions.length} action(s)`
        : "final answer";
      timeline.push(`Iteration ${event.iteration}: planner returned ${planDescription}`);
      break;
    }
    case "agent.tool.start":
      timeline.push(` ↳ Tool ${event.tool} started (cached=${event.cached})`);
      break;
    case "agent.tool.end":
      summary.toolCalls += 1;
      if (event.cached) {
        summary.cacheHits += 1;
      }
      timeline.push(` ↳ Tool ${event.tool} completed in ${typeof event.durationMs === "number" ? event.durationMs.toFixed(2) : event.durationMs}ms`);
      break;
    case "agent.step.done":
      summary.steps = Math.max(summary.steps, (event.iteration ?? 0) + 1);
      if (event.status === "final") {
        timeline.push(`Iteration ${event.iteration} finalised conversation.`);
      }
      break;
    case "agent.run.complete":
      summary.status = "completed";
      summary.durationMs = event.elapsedMs ?? summary.durationMs;
      timeline.push(`Run completed in ${typeof event.elapsedMs === "number" ? event.elapsedMs.toFixed(2) : event.elapsedMs}ms`);
      break;
    case "agent.run.error":
      summary.status = "error";
      summary.durationMs = event.elapsedMs ?? summary.durationMs;
      timeline.push(`Run failed with ${event.error?.code ?? "unknown error"}`);
      break;
    default:
      break;
  }
});

rl.on("close", () => {
  console.log("=== Agent Trace Summary ===");
  console.log(`Session: ${summary.sessionId ?? "unknown"}`);
  console.log(`Agent: ${summary.agentId ?? "unknown"}`);
  console.log(`Status: ${summary.status}`);
  console.log(`Iterations: ${summary.steps}`);
  console.log(`Tool calls: ${summary.toolCalls} (cache hits: ${summary.cacheHits})`);
  console.log(`Prompt tokens: ${summary.promptTokens}`);
  console.log(`Completion tokens: ${summary.completionTokens}`);
  console.log(`Total tokens: ${summary.totalTokens}`);
  console.log(`Estimated cost (USD): ${summary.costUsd.toFixed(6)}`);
  console.log(`Duration (ms): ${summary.durationMs}`);
  console.log("\nTimeline:");
  for (const entry of timeline) {
    console.log(entry);
  }
});

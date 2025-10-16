# Quick Start

This guide walks you through launching a production-ready agent that runs on top of Feather Orchestrator.

## 1. Install

```bash
npm install feather-orchestrator
```

Feather targets Node.js 18+ and ships fully typed ESM modules.

## 2. Choose storage & tools

The agent requires a memory backend and at least one tool. Start with the in-memory backend and the built-in calculator tool:

```typescript
import { Agent, InMemoryMemoryManager, createCalcTool } from "feather-orchestrator";
```

The in-memory backend enforces token budgets and optional summarisation without external services, while `createCalcTool()` exposes a safe evaluator for arithmetic inputs.【F:src/memory/inmemory.ts†L1-L121】【F:src/tools/calc.ts†L1-L92】

## 3. Provide a planner

A planner transforms the latest user turn into either tool calls or a final assistant message. You can bring your own model client and simply ensure the output matches the `AgentPlan` schema. `createJsonPlanner` builds a deterministic planner that sends structured messages to your model, parses the first JSON object in the response, and falls back to a safe clarification prompt when parsing fails.【F:src/agent/planner.ts†L1-L125】【F:src/agent/planner.ts†L127-L263】

```typescript
import { createJsonPlanner } from "feather-orchestrator";

const planner = createJsonPlanner({
  callModel: async ({ messages }) => {
    const completion = await llmClient.chat({ messages, model: "gpt-4o-mini", maxTokens: 512 });
    return completion.content;
  },
  tools: [
    { name: "calc", description: "Evaluate deterministic arithmetic expressions." }
  ],
});
```

## 4. Create the agent

```typescript
const agent = new Agent({
  id: "quick-start",
  planner,
  memory: new InMemoryMemoryManager({ maxTurns: 100 }),
  tools: [createCalcTool()],
});
```

## 5. Run conversations

```typescript
const result = await agent.run({
  sessionId: "demo",
  input: { role: "user", content: "What is (10 + 32) / 2?" },
});

if (result.status === "completed") {
  console.log(result.output.content);
}
```

Each run automatically appends the interaction to memory, emits lifecycle events, and enforces quotas, guardrails, caching, and observability hooks based on your configuration.【F:src/agent/Agent.ts†L1-L654】

## 6. Next steps

- Configure the [Context Builder](./memory.md) to combine summaries, recency, and retrieval snippets under a token budget.
- Enable [prompt caching](./prompt-caching.md) to avoid repeated planner calls.
- Add [guardrails and quotas](./policies-quotas.md) before rolling out to production.
- Pipe metrics into your stack with the [observability guide](./observability.md).

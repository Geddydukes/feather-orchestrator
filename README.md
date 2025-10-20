# Feather Orchestrator

[![npm version](https://badge.fury.io/js/feather-orchestrator.svg)](https://badge.fury.io/js/feather-orchestrator)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)

Feather is a **tiny, fast, dependency-light** framework for orchestrating large language models **and** running production agents.
The core `Feather` orchestrator gives you battle-tested routing, retries, streaming, and metrics across any provider while the
agent runtime layers in planners, guardrails, memory backends, prompt/tool caching, and telemetry pipelines. Everything ships as
modern ESM with a single runtime dependency (`zod`) so you can start lightweight and scale to full workflows when needed.

## ✨ Features

- 🎯 **Provider-Agnostic Orchestrator** – Unified chat/stream API, middleware, rate limits, circuit breaker, retry w/ jitter, and
  end-to-end cost tracking live in `src/core`.
- 🔀 **Fallback, Race & Map Helpers** – Compose providers sequentially or in parallel with `fallback`, `race`, and `map`
  utilities baked into the orchestrator instance.
- 🧠 **Agent Runtime** – Iterative planner → act → observe loop with per-step guardrails, quota enforcement, cached tools,
  structured telemetry, and memory/context building modules under `src/agent` and `src/memory`.
- 💾 **Durable Memory Stores** – In-memory, Redis, and Postgres managers plus auditing/redaction wrappers and SQL migrations for
  regulated workloads.
- 🧰 **Built-in Tools** – Deterministic calculator, web search scaffold, and a caching decorator to memoize expensive operations.
  Tool interfaces mirror the agent runtime for custom integrations.
- 🛰️ **Telemetry & Observability** – NDJSON event stream, OpenTelemetry bridge, replay script, and Grafana starter dashboard so
  you can trace orchestrator and agent behavior in prod.
- 🧮 **Policy, Quota & Guardrails** – Token budgets, tool allow/deny lists, custom validators, and rate controls ensure safe
  execution even with untrusted input.
- 🧩 **Extensible Provider Registry** – Configure semantic aliases, pricing, and capability metadata in `feather.config.json`
  and load them with `buildRegistry` for automatic selection.

## 🚀 Quick Start

### Installation

```bash
npm install feather-orchestrator
# or
yarn add feather-orchestrator
# or
pnpm add feather-orchestrator
```

> Requires **Node.js 18+** (uses global `fetch`). Modules ship as ESM only.

### Configure Providers (Optional but Recommended)

Declare models, pricing, and policies in `feather.config.json`:

```jsonc
{
  "policy": "cheapest",
  "providers": {
    "openai": {
      "apiKeyEnv": "OPENAI_API_KEY",
      "models": [
        {
          "name": "gpt-4o-mini",
          "aliases": ["smart"],
          "inputPer1K": 0.005,
          "outputPer1K": 0.015,
          "capabilities": ["chat", "stream", "json", "tools"]
        }
      ]
    },
    "anthropic": {
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "models": [
        {
          "name": "claude-3-5-haiku",
          "aliases": ["fast"],
          "inputPer1K": 0.008,
          "outputPer1K": 0.024,
          "capabilities": ["chat", "stream"]
        }
      ]
    }
  }
}
```

Load it into a provider registry:

```typescript
import { Feather, buildRegistry, openai, anthropic } from "feather-orchestrator";
import config from "./feather.config.json" assert { type: "json" };

const registry = buildRegistry(config);
const feather = new Feather({
  registry,
  providers: {
    openai: openai({ apiKey: process.env.OPENAI_API_KEY! }),
    anthropic: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
  },
  limits: {
    "openai:gpt-4o-mini": { rps: 10, burst: 20 },
    "anthropic:claude-3-5-haiku": { rps: 5, burst: 10 }
  },
  retry: { maxAttempts: 3, baseMs: 500, jitter: "full" },
  middleware: [async (ctx, next) => { await next(); console.log(ctx.response?.costUSD); }]
});
```

### Call the Orchestrator

```typescript
const answer = await feather.chat({
  model: "smart",
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Ship status?" }
  ]
});

console.log(answer.content);
console.log(`Cost: $${answer.costUSD?.toFixed(4) ?? 0}`);
```

Stream responses or orchestrate multiple providers:

```typescript
const messages = [
  { role: "user", content: "Stream me a limerick about databases." }
];

for await (const delta of feather.stream.chat({
  provider: "openai",
  model: "gpt-4o-mini",
  messages
})) {
  process.stdout.write(delta.content ?? "");
}

const fallbackChain = feather.fallback([
  { provider: "openai", model: "gpt-4o-mini" },
  { provider: "anthropic", model: "claude-3-5-haiku" }
]);

const raceChain = feather.race([
  { provider: "openai", model: "gpt-4o-mini" },
  { provider: "anthropic", model: "claude-3-5-haiku" }
]);

const [fallbackResponse, raceResponse] = await Promise.all([
  fallbackChain.chat({ messages }),
  raceChain.chat({ messages })
]);

console.log(fallbackResponse.content, raceResponse.content);
```

### Run the Agent Loop

```typescript
import {
  Agent,
  createJsonPlanner,
  InMemoryMemoryManager,
  createCalcTool,
  withToolCache
} from "feather-orchestrator";

const planner = createJsonPlanner({
  callModel: async ({ messages }) =>
    feather.chat({ model: "smart", messages }).then((r) => r.content),
  tools: [{ name: "calc", description: "Deterministic arithmetic" }]
});

const agent = new Agent({
  id: "support",
  planner,
  memory: new InMemoryMemoryManager({ maxTurns: 200 }),
  tools: [withToolCache(createCalcTool(), { cache: { ttlSeconds: 60 } })],
  policies: {
    allowedTools: ["calc"],
    maxIterations: 5
  }
});

const result = await agent.run({
  sessionId: "customer-123",
  input: { role: "user", content: "Can you double-check 42 * 17?" }
});
```

The agent enforces guardrails, records memories, and emits `completed`, `errored`, or `aborted` events you can forward to the
telemetry pipeline.

## 📖 Complete API Reference

### Agent Framework

Production agent primitives live under `src/agent` and `src/memory`. Start with the docs in [`docs/`](docs/) for deep dives on
memory, prompt caching, policies, observability, and troubleshooting. Highlighted types:

- [`Agent`](src/agent/Agent.ts) – Orchestrates planner/tool execution with event hooks and guardrail enforcement.
- [`createJsonPlanner`](src/agent/planner.ts) – Opinionated planner that forces structured JSON tool calls.
- [`ContextBuilder`](src/agent/context-builder.ts) – Assembles conversation history + retrieval results under token budgets.
- [`QuotaManager`](src/agent/quotas.ts) / [`RedisQuotaManager`](src/agent/quotas-redis.ts) – Enforce per-session spend/iteration caps.
- [`InMemoryMemoryManager`](src/memory/in-memory.ts), [`RedisMemoryManager`](src/memory/redis.ts),
  [`PostgresMemoryManager`](src/memory/postgres.ts) – Durable stores with audit/redaction wrappers.
- [`withToolCache`](src/tools/cache.ts) – Wrap any tool with TTL caching backed by prompt/tool cache stores.

Examples in [`examples/`](examples/) demonstrate agent chaining, real-world sessions, and telemetry streaming.

### Core Classes

#### `Feather`

Main orchestrator managing providers, registry lookups, rate limiting, retries, circuit breaking, streaming, and middleware.

```typescript
interface FeatherOpts {
  providers?: Record<string, ChatProvider>;
  registry?: ProviderRegistry;
  limits?: Record<string, { rps: number; burst?: number }>;
  retry?: RetryOpts;
  timeoutMs?: number;
  middleware?: Middleware[];
}
```

#### `ChatProvider`

Any provider implementation must satisfy:

```typescript
interface ChatProvider {
  id: string;
  chat(req: ChatRequest, opts?: CallOpts): Promise<ChatResponse>;
  stream?(req: ChatRequest, opts?: CallOpts): AsyncIterable<ChatDelta>;
  estimate?(req: ChatRequest): TokenEstimate;
  price?: PriceTable;
}
```

#### `ProviderRegistry`

`buildRegistry` loads configuration from JSON and picks providers/models using the desired policy (`cheapest`, `roundrobin`, or
`first`). Each entry carries pricing and capability metadata for routing and billing.

### Methods

#### `feather.chat(options)`

Send a chat request to a specific provider or semantic alias. Throws when messages are empty or parameters fall outside their
validated ranges.

```typescript
const response = await feather.chat({
  model: "smart",
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello!" }
  ],
  temperature: 0.7,
  maxTokens: 500
});
```

`ChatResponse` includes token usage, cost attribution, and the raw provider payload when available.

#### `feather.fallback(providers).chat(options)`

Try providers in sequence until one succeeds.

```typescript
const fallbackChain = feather.fallback([
  { provider: "openai", model: "gpt-4o-mini" },
  { provider: "anthropic", model: "claude-3-5-haiku" },
  { provider: "openai", model: "gpt-4o-mini" }
]);

const response = await fallbackChain.chat({
  messages: [{ role: "user", content: "Hello!" }]
});
```

#### `feather.race(providers).chat(options)`

Execute providers in parallel and return the first successful response.

```typescript
const raceChain = feather.race([
  { provider: "openai", model: "gpt-4o-mini" },
  { provider: "anthropic", model: "claude-3-5-haiku" }
]);

const response = await raceChain.chat({
  messages: [{ role: "user", content: "Hello!" }]
});
```

#### `feather.stream.chat(options)`

Stream responses as deltas. Throws if the target provider lacks streaming support.

```typescript
for await (const delta of feather.stream.chat({
  provider: "openai",
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Write a story." }],
  timeoutMs: 30000
})) {
  process.stdout.write(delta.content ?? "");
}
```

#### `feather.map(items, fn, options)`

Process workloads with bounded concurrency using orchestrator-managed limits and retries.

```typescript
const prompts = ["Explain AI", "What is React?", "How does HTTP work?"];

const results = await feather.map(
  prompts,
  async (prompt) => {
    const response = await feather.chat({
      model: "fast",
      messages: [{ role: "user", content: prompt }]
    });
    return { prompt, response: response.content };
  },
  { concurrency: 2 }
);
```

## 🎯 Advanced Usage

### Provider-Agnostic Configuration

Route by semantic alias, price, or capability by combining `feather.config.json` with `buildRegistry`. Config schema supports
capability filtering and environment variable indirection.

### Middleware System

Attach middleware for logging, tracing, redaction, prompt caching, or custom metrics. Middleware runs around every request and
has access to both request/response state.

```typescript
const feather = new Feather({
  providers: { /* ... */ },
  middleware: [
    async (ctx, next) => {
      const start = Date.now();
      await next();
      console.log(`${ctx.provider}:${ctx.model} in ${Date.now() - start}ms`);
    },
    createPromptCacheMiddleware({
      cache: new PromptCache({ ttlSeconds: 600 })
    })
  ]
});
```

### Rate Limiting & Quotas

Combine orchestrator `limits` with agent quota managers for holistic safety. The orchestrator uses token buckets while the agent
can enforce per-session iteration counts or monetary budgets via `QuotaManager`/`RedisQuotaManager`.

### Retry Configuration

`withRetry` applies exponential backoff, jitter, and abort-signal awareness around provider calls. Override defaults per request
or per orchestrator instance.

### Circuit Breaker

Breakers isolate failing providers automatically; events emit via `onEvent` so you can alert on open/close transitions.

## 🛠️ Adding Custom Providers

Implement the `ChatProvider` interface and expose streaming/price metadata as available:

```typescript
import type { ChatProvider } from "feather-orchestrator";

export function customProvider(config: { apiKey: string }): ChatProvider {
  return {
    id: "custom",
    async chat(req) {
      const resp = await fetch("https://api.custom-llm.com/chat", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(req)
      });

      if (!resp.ok) throw new Error(`Custom API error: ${resp.status}`);
      const data = await resp.json();
      return {
        content: data.choices[0].message.content,
        tokens: {
          input: data.usage.prompt_tokens,
          output: data.usage.completion_tokens
        },
        costUSD: data.cost_usd,
        raw: data
      };
    },
    async *stream(req) {
      // Optional: implement SSE or chunked transfer decoding
    },
    price: { inputPer1K: 0.001, outputPer1K: 0.002 }
  };
}
```

Register the provider alongside first-party ones and compose it in fallback/race chains as needed.

## 🖥️ CLI Usage

Feather ships a lightweight CLI for quick prompts and smoke testing.

```bash
# Install globally
npm install -g feather-orchestrator

# Or run with npx
npx feather chat -m smart -q "What is machine learning?"

# Pin a provider
npx feather chat -p openai -m gpt-4o-mini -q "Hello world"

# Use a custom config file
npx feather chat -c ./my-config.json -m fast -q "Explain AI"
```

### CLI Options

```bash
feather chat [options]

Options:
  -p, --provider <provider>  Provider name (optional with registry)
  -m, --model <model>        Model name or alias
  -q, --query <query>        User message
  -c, --config <file>        Config file path (default: feather.config.json)
  -h, --help                 Show help
```

## 🔧 Configuration Reference

### `feather.config.json`

Supports policies (`cheapest`, `roundrobin`, `first`), capability gating, and environment indirection for secrets.

### Environment Variables

```bash
# Provider credentials
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
REDIS_URL=redis://localhost:6379
DATABASE_URL=postgres://...

# Optional overrides
FEATHER_CONFIG=./config/feather.config.json
FEATHER_PROMPT_CACHE_DIR=./.feather-cache
```

## 🤖 Agent Chaining Patterns

Feather’s orchestrator and agent runtime interoperate so you can compose complex flows:

### Sequential Agents

Chain specialized agents by feeding outputs into new sessions or tool calls. See [`examples/agent-chaining.ts`](examples/agent-chaining.ts).

### Conditional Routing

Use planner outputs or classifier models to route traffic to specialized agent instances based on intent or policy.

### Parallel Analysis

Fan out tasks with `feather.race`/`feather.map`, merge results, and feed them back through an agent for synthesis.

### Iterative Improvement

Set `maxIterations` and memory policies to enforce bounded feedback loops with contextual recall.

## 🏗️ Real-World Examples

- [`examples/chat.ts`](examples/chat.ts) – Orchestrator usage, fallback/race helpers, and streaming.
- [`examples/agent-chaining.ts`](examples/agent-chaining.ts) – Planner-driven agents with guardrails.
- [`examples/real-world-app.ts`](examples/real-world-app.ts) – Long-running sessions with memory/context builders.
- [`scripts/replay.ts`](scripts/replay.ts) – Replay NDJSON telemetry for demos or debugging.

Run them via npm scripts in `package.json`.

## 🔒 Security Best Practices

- Store API keys in environment variables and inject via `feather.config.json` indirection.
- Add middleware to redact PII or enforce content policies before requests leave your network.
- Apply conservative rate limits and quotas (`limits`, `QuotaManager`) when exposing public endpoints.
- Use `AuditMemory` and `RedactingMemory` to manage compliance-sensitive transcripts.

## 🧪 Testing

- `npm test` runs Vitest unit/integration coverage for orchestrator, agent, memory, provider, and telemetry modules.
- `npm run lint` type-checks the TypeScript source.
- `npm run build` emits ESM bundles to `dist/`.

## 📊 Monitoring & Observability

- Subscribe to `feather.onEvent` or `agent.onEvent` for NDJSON streams; forward them to logs, Kafka, or the included replay tool.
- Export OpenTelemetry metrics using the `createOtelAgentObserver` helper for integration with Grafana/Tempo/Jaeger.
- Import the dashboard starter from [`examples/observability-dashboard.json`](examples/observability-dashboard.json).

## 🚀 Deployment

### Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build
CMD ["node", "dist/examples/chat.js"]
```

### Environment Variables

```bash
# Production environment
NODE_ENV=production
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
REDIS_URL=redis://cache.internal:6379
DATABASE_URL=postgres://user:pass@db:5432/feather
```

### Kubernetes ConfigMap Snippet

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: feather-config
data:
  feather.config.json: |
    {
      "policy": "cheapest",
      "providers": {
        "openai": {
          "apiKeyEnv": "OPENAI_API_KEY",
          "models": [
            {
              "name": "gpt-4o-mini",
              "aliases": ["smart"],
              "inputPer1K": 0.005,
              "outputPer1K": 0.015
            }
          ]
        }
      }
    }
```

## 🤝 Contributing

1. Fork the repository.
2. Install dependencies with `npm install`.
3. Run `npm test` and `npm run lint` before submitting.
4. Open a pull request describing your changes and include relevant docs/examples.

### Adding New Providers

1. Add a file in [`src/providers/`](src/providers/).
2. Implement the `ChatProvider` interface.
3. Wire exports through [`src/index.ts`](src/index.ts).
4. Add tests under [`tests/providers/`](tests/providers/).
5. Document usage in this README or supporting docs.

## 📄 License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for details.

## 🙏 Acknowledgments

Built with ❤️ for teams shipping reliable LLM products. Thanks to every contributor experimenting with Feather, filing issues, and
sharing telemetry traces—we appreciate you!

---

# Feather Orchestrator Agent Framework Overview

This document summarizes the production-ready agent framework that now ships with Feather Orchestrator. It highlights the major subsystems, their responsibilities, and where to find deeper documentation or code examples.

## Agent Execution Loop
- Location: [`src/agent/Agent.ts`](../src/agent/Agent.ts)
- Responsibilities: orchestrates plan → act → observe cycles, emits detailed lifecycle events, enforces iteration limits, and writes conversation turns to configured memory backends.
- Highlights: planner JSON validation, guarded tool invocation with quotas and policies, tool cache integration, telemetry hooks, and final result normalization.

## Planning & Tools
- Planner prompt and parsing utilities live in [`src/agent/planner.ts`](../src/agent/planner.ts) with validation helpers in [`src/agent/plan.ts`](../src/agent/plan.ts).
- Built-in tools:
  - [`calc`](../src/tools/calc.ts): deterministic math evaluator with expression validation and sandboxing.
  - [`web.search`](../src/tools/webSearch.ts): provider-agnostic search bridge with query sanitization and schema-checked results.
  - [`withToolCache`](../src/tools/cache.ts): caching helper that wraps expensive tools while respecting guardrails.
- Tool typings reside in [`src/tools/types.ts`](../src/tools/types.ts) and are re-exported via [`src/tools/index.ts`](../src/tools/index.ts).

## Memory & Context
- Core interfaces: [`src/memory/types.ts`](../src/memory/types.ts).
- Backends:
  - In-memory: [`src/memory/inmemory.ts`](../src/memory/inmemory.ts)
  - Redis: [`src/memory/redis.ts`](../src/memory/redis.ts)
  - Postgres: [`src/memory/postgres.ts`](../src/memory/postgres.ts) with migrations in [`db/migrations/001_create_agent_memory.sql`](../db/migrations/001_create_agent_memory.sql)
- Compliance layers: [`src/memory/redaction.ts`](../src/memory/redaction.ts) and [`src/memory/audit.ts`](../src/memory/audit.ts).
- Context builder: [`src/agent/context-builder.ts`](../src/agent/context-builder.ts) composes recent turns, summaries, digests, and RAG snippets under configurable token budgets.
- Token counting: [`src/memory/tokenizer.ts`](../src/memory/tokenizer.ts) provides deterministic estimation without external dependencies.

## Guardrails & Quotas
- Policy enforcement and validation live in [`src/agent/policies.ts`](../src/agent/policies.ts).
- In-memory quota manager: [`src/agent/quotas.ts`](../src/agent/quotas.ts)
- Redis-backed quota manager: [`src/agent/quotas-redis.ts`](../src/agent/quotas-redis.ts)
- Guardrail tests: [`tests/agent/guardrails.test.ts`](../tests/agent/guardrails.test.ts)

## Caching
- Prompt cache middleware and helpers reside in [`src/core/prompt-cache.ts`](../src/core/prompt-cache.ts) and [`src/core/middleware/promptCache.ts`](../src/core/middleware/promptCache.ts), with key hashing in [`src/core/prompt-key.ts`](../src/core/prompt-key.ts).
- Tool cache implementation is in [`src/core/tool-cache.ts`](../src/core/tool-cache.ts) and the tool wrapper in [`src/tools/cache.ts`](../src/tools/cache.ts).

## Telemetry & Observability
- Event emitters and NDJSON trace helpers: [`src/telemetry/events.ts`](../src/telemetry/events.ts)
- OpenTelemetry bridge: [`src/telemetry/otel.ts`](../src/telemetry/otel.ts)
- Example dashboards and scripts: [`examples/observability.ts`](../examples/observability.ts) and [`examples/observability-dashboard.json`](../examples/observability-dashboard.json)
- Trace replay utility: [`scripts/replay.ts`](../scripts/replay.ts)

## Documentation & Examples
- Quick start: [`docs/quick-start.md`](quick-start.md)
- Memory guide: [`docs/memory.md`](memory.md)
- Prompt caching: [`docs/prompt-caching.md`](prompt-caching.md)
- Policies & quotas: [`docs/policies-quotas.md`](policies-quotas.md)
- Observability: [`docs/observability.md`](observability.md)
- Troubleshooting: [`docs/troubleshooting.md`](troubleshooting.md)
- Tool caching example: [`examples/tool-cache.ts`](../examples/tool-cache.ts)

## Testing Infrastructure
- Agent loop and planner suites: [`tests/agent/*.test.ts`](../tests/agent)
- Memory backends: [`tests/memory/*.test.ts`](../tests/memory)
- Caching and middleware: [`tests/core/*.test.ts`](../tests/core)
- Telemetry collectors: [`tests/telemetry/*.test.ts`](../tests/telemetry)
- Mock infrastructure: [`tests/helpers`](../tests/helpers)

Refer to these entry points to navigate the codebase quickly when making changes or onboarding new contributors.

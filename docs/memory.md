# Memory Backends & Context Building

The agent framework ships three production-ready memory managers. Each manager implements the shared `MemoryManager` interface and supports append, summarise, trimming, and token budgeting.

## In-memory

`InMemoryMemoryManager` stores turns in-process with optional limits on total turns, summary recency, and custom summarisation strategies. The manager lazily attaches token metadata to every turn so retrieval requests can enforce budgets without external tokenisers.【F:src/memory/inmemory.ts†L1-L121】

Use it for local development, single-process deployments, or as a cache in front of persistent storage.

## Redis

`RedisMemoryManager` persists turns in Redis lists and relies on Lua helpers to guarantee atomic append + trim behaviour. It refreshes TTLs, supports summarisation, and gracefully falls back when scripts are unavailable. Configure connection factories and optional JSON serialisation hooks to match your infrastructure.【F:src/memory/redis.ts†L1-L208】【F:src/memory/redis.ts†L249-L387】

Pair Redis memory with the Redis quota manager to achieve consistent limits across sessions.

## Postgres

`PostgresMemoryManager` writes turns into the `agent_memory_turns` table and retrieves context slices with transactional guarantees. It exposes options for connection pooling, chunked summarisation, and strict quoting for session identifiers to avoid injection. The included migration creates the table and indexes optimised for session queries.【F:src/memory/postgres.ts†L1-L190】【F:db/migrations/001_create_agent_memory.sql†L1-L14】

## Token counting

All backends share the lightweight whitespace tokenizer. You can override it with any function that returns token estimates for message payloads, ensuring strict max-token budgeting inside `getContext` calls.【F:src/memory/tokenizer.ts†L1-L56】【F:src/memory/types.ts†L1-L27】

## Context builder

`ContextBuilder` assembles system instructions, conversation history, digests, and retrieval snippets under a single token budget. It preserves the newest turns verbatim, collapses older ones via the digest strategy, and drops retrieval items last to stay within limits.【F:src/agent/context-builder.ts†L1-L158】【F:src/agent/context-builder.ts†L222-L344】

When invoked, provide:

```typescript
const builder = new ContextBuilder({
  baseMessages: systemPrompt,
  memory,
  maxTokens: 4000,
  maxRecentTurns: 8,
});

const messages = await builder.build({
  sessionId,
  retrievals: ragResults,
});
```

Feed the resulting messages into your planner to maintain deterministic contexts.

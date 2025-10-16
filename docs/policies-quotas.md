# Policies, Guardrails & Quotas

Production agents must validate tool usage, redact sensitive data, and enforce rate limits. The agent integrates these capabilities through configurable policies and quota managers.

## Policy engine

Policies combine tool whitelisting, schema validation, redaction, and audit hooks. You can provide a full `AgentPolicies` instance or a plain config object that the framework converts on startup. Each tool invocation executes validation before the tool runs and emits guardrail events when a call is blocked.【F:src/agent/policies.ts†L1-L210】【F:src/agent/Agent.ts†L310-L497】

Example:

```typescript
const policies = createAgentPolicies({
  tools: {
    "web.search": {
      schema: z.object({ query: z.string().min(3) }),
      redact: (input) => ({ ...input, query: maskPII(input.query) }),
      audit: (input, result) => ({ query: input.query, resultCount: result.items?.length ?? 0 }),
    },
  },
});
```

Pass the policies to the agent to enforce them globally.

## Redaction & audit wrappers

You can decorate any `MemoryManager` with the provided redaction and audit helpers. Redaction filters specific roles or turns before persistence, while audit forwards structured events to your compliance sink.【F:src/memory/redaction.ts†L1-L147】【F:src/memory/audit.ts†L1-L100】

## Quotas

Quotas are enforced via pluggable managers. The in-memory quota manager tracks per-session allowances with a fixed window counter and returns structured errors that the agent surfaces to clients.【F:src/agent/quotas.ts†L1-L151】

When operating at scale, switch to the Redis quota manager. It runs atomic Lua scripts to increment counters, enforces expirations, and shares the same configuration shape as the in-memory variant.【F:src/agent/quotas-redis.ts†L1-L214】

Attach quotas by passing either an instantiated manager or a plain config object to the agent constructor.

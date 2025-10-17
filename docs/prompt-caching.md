# Prompt & Tool Caching

Prompt and tool caches reduce latency and provider spend by skipping repeated calls on deterministic workloads.

## Prompt cache middleware

The prompt cache middleware wraps planner calls. It hashes the planner input with `promptKey`, checks a key/value store, and short-circuits execution on cache hits. The middleware automatically skips caching when the planner sets `temperature > 0.3` or when multi-step plans are enabled, protecting against non-deterministic responses.【F:src/core/prompt-cache.ts†L1-L157】【F:src/core/middleware/promptCache.ts†L1-L63】

To enable caching:

```typescript
import { PromptCache, createPromptCacheMiddleware } from "feather-orchestrator";

const cache = new PromptCache({ ttlSeconds: 600 });
const middleware = createPromptCacheMiddleware({ cache });
```

Attach the middleware to your planner pipeline or `Agent` configuration.

### Cache key format

Prompt cache keys include a schema version so deployments can invalidate stale entries when the key format evolves. The current
shape is `prompt:v1:<sha256>` where `v1` identifies the canonical serialization. Message content is normalized before hashing so
whitespace-only changes do not create distinct cache entries.【F:src/core/prompt-key.ts†L1-L75】

## Tool cache helper

`ToolCache` offers deterministic hashing, TTL-aware storage, and safe cloning of cached results. Wrap expensive tools with `withToolCache` to hydrate results directly from cache during the agent loop. Cache events propagate through agent telemetry so observability dashboards display hit ratios per tool.【F:src/core/tool-cache.ts†L1-L216】【F:src/tools/cache.ts†L1-L87】

```typescript
import { ToolCache, withToolCache } from "feather-orchestrator";

const toolCache = new ToolCache({ ttlSeconds: 300 });
const cachedSearch = withToolCache(webSearchTool, { cache: toolCache });
```

The agent automatically writes sanitized results back into the cache and respects guardrails and quotas on both cache hits and misses.【F:src/agent/Agent.ts†L1-L654】

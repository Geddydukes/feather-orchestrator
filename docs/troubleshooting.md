# Troubleshooting

## `npx vitest` fails with HTTP 403

Some environments block registry access, causing the Vitest CLI download to fail. Install `vitest` as a project dependency and invoke it via `npm test` or run `node ./node_modules/vitest/vitest.mjs` directly. The test suites cover agent flows, caches, memory backends, and telemetry, so maintaining a local copy ensures reproducible CI runs.

## Planner returns invalid JSON

If the planner model produces malformed JSON, the agent extracts the first JSON object from the response and validates it. When validation fails, the agent emits an `agent.plan.error` event and retries according to your configuration. Inspect trace logs and adjust your prompts or provide a deterministic parser override.【F:src/agent/planner.ts†L1-L263】【F:src/agent/Agent.ts†L118-L309】

## Tool call rejected by policies

Guardrails may block a tool call due to disallowed tools or schema violations. The agent emits `agent.tool.error` with the policy error details and returns a structured `AgentError` with the `TOOL_NOT_ALLOWED` or `TOOL_VALIDATION_FAILED` code. Update your policy configuration or adjust the planner output accordingly.【F:src/agent/policies.ts†L1-L210】【F:src/agent/Agent.ts†L310-L497】

## Memory exceeds token budget

All memory managers truncate turns when budgets are exceeded. Ensure your context builder budget matches the downstream model’s `maxTokens`, and adjust summarisation thresholds or trimming policies to retain critical context.【F:src/memory/inmemory.ts†L36-L121】【F:src/memory/redis.ts†L249-L387】【F:src/memory/postgres.ts†L118-L190】

# Observability

Every agent emits structured events for planning, tool execution, memory operations, and final responses. You can forward these events to your telemetry stack or use the provided helpers to export metrics directly.

## Event stream

Pass an `onEvent` callback to the `Agent` constructor to receive lifecycle events that contain timestamps, metadata, token usage, and cache hits. The helper `createTelemetryProxy` fans events out to multiple sinks while preserving ordering.【F:src/telemetry/events.ts†L1-L211】【F:src/agent/Agent.ts†L75-L309】

## NDJSON tracing

Use `createNdjsonTraceSink` to record each run as a newline-delimited JSON file. The trace contains the planner decisions, tool results, and summaries for deterministic replay or debugging.【F:src/telemetry/events.ts†L213-L392】

## OpenTelemetry metrics

The optional OTel module exports counters, histograms, and observable gauges that track run latency, token usage, cache hit rates, and error codes. Register the meters with your SDK and hook them into Prometheus or any supported backend.【F:src/telemetry/otel.ts†L1-L165】

## Example

Check `examples/observability.ts` for a runnable script that wires the agent to the telemetry utilities and prints aggregated stats to the console. The repository also includes a Grafana dashboard JSON you can import to visualise latency, cache behaviour, and tool activity.【F:examples/observability.ts†L1-L55】【F:examples/observability-dashboard.json†L1-L72】

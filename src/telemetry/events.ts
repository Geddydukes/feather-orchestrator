import type { AgentAssistantMessage, AgentError, AgentEvent, TokenUsage } from "../agent/types.js";
import type {
  MemoryGetContextOptions,
  MemoryManager,
  MemoryTrimOptions,
  MemoryTurn,
} from "../memory/types.js";

export interface MemoryEventingOptions {
  agentId?: string;
  emit: (event: AgentEvent) => void;
}

function safeEmit(options: MemoryEventingOptions, event: AgentEvent): void {
  try {
    options.emit({ ...event, agentId: event.agentId ?? options.agentId });
  } catch (error) {
    console.error("Memory telemetry emit failed", error);
  }
}

export function withMemoryEventing<TTurn extends MemoryTurn>(
  memory: MemoryManager<TTurn>,
  options: MemoryEventingOptions
): MemoryManager<TTurn> {
  const instrumented: MemoryManager<TTurn> = {
    async append(sessionId: string, turn: TTurn): Promise<void> {
      await memory.append(sessionId, turn);
      safeEmit(options, {
        type: "agent.memory.append",
        sessionId,
        turn,
        agentId: options.agentId,
      });
    },

    async getContext(sessionId: string, ctxOptions?: MemoryGetContextOptions): Promise<TTurn[]> {
      return memory.getContext(sessionId, ctxOptions);
    },
  };

  if (typeof memory.summarize === "function") {
    instrumented.summarize = async (sessionId: string): Promise<void> => {
      await memory.summarize!(sessionId);
      safeEmit(options, {
        type: "agent.memory.summarize",
        sessionId,
        agentId: options.agentId,
      });
    };
  }

  if (typeof memory.trim === "function") {
    instrumented.trim = async (sessionId: string, trimOptions: MemoryTrimOptions = {}): Promise<void> => {
      await memory.trim!(sessionId, trimOptions);
      safeEmit(options, {
        type: "agent.memory.trim",
        sessionId,
        retainTurns: trimOptions.retainTurns,
        agentId: options.agentId,
      });
    };
  }

  return instrumented;
}

export interface TraceEvent {
  timestamp: Date;
  event: AgentEvent;
}

export interface AgentRunMetrics {
  iterationCount: number;
  planDurationMs: number;
  toolDurationMs: number;
  stepDurationMs: number;
  toolCalls: number;
  toolErrors: number;
  toolCacheHits: number;
  stepErrors: number;
  memoryAppends: number;
  memorySummaries: number;
  memoryTrims: number;
  contextTokensTotal: number;
  contextTokensMax: number;
  contextTurnsMax: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export type AgentRunSnapshotResult =
  | { type: "completed"; output: AgentAssistantMessage }
  | { type: "error"; error: AgentError };

export interface AgentRunSnapshot {
  sessionId: string;
  agentId?: string;
  status: "running" | "completed" | "error";
  startedAt?: Date;
  completedAt?: Date;
  elapsedMs?: number;
  metadata?: Record<string, unknown>;
  metrics: AgentRunMetrics;
  events: TraceEvent[];
  result?: AgentRunSnapshotResult;
}

interface RunState {
  sessionId: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
  startedAt?: Date;
  events: TraceEvent[];
  metrics: AgentRunMetricsInternal;
}

interface AgentRunMetricsInternal extends AgentRunMetrics {}

function createEmptyMetrics(): AgentRunMetricsInternal {
  return {
    iterationCount: 0,
    planDurationMs: 0,
    toolDurationMs: 0,
    stepDurationMs: 0,
    toolCalls: 0,
    toolErrors: 0,
    toolCacheHits: 0,
    stepErrors: 0,
    memoryAppends: 0,
    memorySummaries: 0,
    memoryTrims: 0,
    contextTokensTotal: 0,
    contextTokensMax: 0,
    contextTurnsMax: 0,
  };
}

function cloneMetrics(metrics: AgentRunMetricsInternal): AgentRunMetrics {
  return { ...metrics };
}

function cloneEvents(events: TraceEvent[]): TraceEvent[] {
  return events.map((entry) => ({
    timestamp: new Date(entry.timestamp.getTime()),
    event: entry.event,
  }));
}

export interface AgentRunTrackerOptions {
  clock?: () => Date;
  storeEvents?: boolean;
}

export interface AgentRunTracker {
  handle(event: AgentEvent, timestamp?: Date): AgentRunSnapshot | undefined;
  get(sessionId: string): AgentRunSnapshot | undefined;
  getActiveRuns(): AgentRunSnapshot[];
  clear(sessionId?: string): void;
}

export function createAgentRunTracker(options: AgentRunTrackerOptions = {}): AgentRunTracker {
  const runs = new Map<string, RunState>();
  const clock = options.clock ?? (() => new Date());
  const storeEvents = options.storeEvents !== false;

  function handle(event: AgentEvent, timestamp?: Date): AgentRunSnapshot | undefined {
    const time = timestamp ?? clock();

    let state: RunState | undefined;
    if (event.type === "agent.run.start") {
      state = {
        sessionId: event.sessionId,
        agentId: event.agentId,
        metadata: event.metadata,
        startedAt: time,
        events: [],
        metrics: createEmptyMetrics(),
      };
      runs.set(event.sessionId, state);
    } else {
      state = runs.get(event.sessionId);
      if (!state) {
        state = {
          sessionId: event.sessionId,
          agentId: event.agentId,
          events: [],
          metrics: createEmptyMetrics(),
        };
        runs.set(event.sessionId, state);
      }
    }

    if (event.agentId && !state.agentId) {
      state.agentId = event.agentId;
    }

    if (storeEvents) {
      state.events.push({ timestamp: time, event });
    }

    updateMetrics(state.metrics, event);

    if (event.type === "agent.run.complete") {
      state.agentId = state.agentId ?? event.agentId;
      const snapshot: AgentRunSnapshot = {
        sessionId: state.sessionId,
        agentId: state.agentId,
        status: "completed",
        startedAt: state.startedAt,
        completedAt: time,
        elapsedMs: event.elapsedMs,
        metadata: state.metadata,
        metrics: cloneMetrics(state.metrics),
        events: storeEvents ? cloneEvents(state.events) : [],
        result: { type: "completed", output: event.output },
      };
      runs.delete(event.sessionId);
      return snapshot;
    }

    if (event.type === "agent.run.error") {
      state.agentId = state.agentId ?? event.agentId;
      const snapshot: AgentRunSnapshot = {
        sessionId: state.sessionId,
        agentId: state.agentId,
        status: "error",
        startedAt: state.startedAt,
        completedAt: time,
        elapsedMs: event.elapsedMs,
        metadata: state.metadata,
        metrics: cloneMetrics(state.metrics),
        events: storeEvents ? cloneEvents(state.events) : [],
        result: { type: "error", error: event.error },
      };
      runs.delete(event.sessionId);
      return snapshot;
    }

    return undefined;
  }

  function get(sessionId: string): AgentRunSnapshot | undefined {
    const state = runs.get(sessionId);
    if (!state) {
      return undefined;
    }
    return {
      sessionId: state.sessionId,
      agentId: state.agentId,
      status: "running",
      startedAt: state.startedAt,
      metadata: state.metadata,
      metrics: cloneMetrics(state.metrics),
      events: storeEvents ? cloneEvents(state.events) : [],
    };
  }

  function getActiveRuns(): AgentRunSnapshot[] {
    return Array.from(runs.values()).map((state) => ({
      sessionId: state.sessionId,
      agentId: state.agentId,
      status: "running",
      startedAt: state.startedAt,
      metadata: state.metadata,
      metrics: cloneMetrics(state.metrics),
      events: storeEvents ? cloneEvents(state.events) : [],
    }));
  }

  function clear(sessionId?: string): void {
    if (sessionId) {
      runs.delete(sessionId);
      return;
    }
    runs.clear();
  }

  return { handle, get, getActiveRuns, clear };
}

function updateMetrics(metrics: AgentRunMetricsInternal, event: AgentEvent): void {
  switch (event.type) {
    case "agent.plan":
      metrics.planDurationMs += event.durationMs;
      addUsage(metrics, event.usage);
      break;
    case "agent.tool.end":
      metrics.toolCalls += 1;
      metrics.toolDurationMs += event.durationMs;
      if (event.cached) {
        metrics.toolCacheHits += 1;
      }
      addUsage(metrics, event.usage);
      break;
    case "agent.tool.error":
      metrics.toolErrors += 1;
      metrics.toolDurationMs += event.durationMs;
      break;
    case "agent.step.start":
      metrics.iterationCount = Math.max(metrics.iterationCount, event.iteration + 1);
      if (typeof event.contextTokens === "number") {
        metrics.contextTokensTotal += event.contextTokens;
        metrics.contextTokensMax = Math.max(metrics.contextTokensMax, event.contextTokens);
      }
      metrics.contextTurnsMax = Math.max(metrics.contextTurnsMax, event.contextTurns);
      break;
    case "agent.step.done":
      metrics.stepDurationMs += event.durationMs;
      metrics.iterationCount = Math.max(metrics.iterationCount, event.iteration + 1);
      if (event.status === "error") {
        metrics.stepErrors += 1;
      }
      break;
    case "agent.memory.append":
      metrics.memoryAppends += 1;
      break;
    case "agent.memory.summarize":
      metrics.memorySummaries += 1;
      break;
    case "agent.memory.trim":
      metrics.memoryTrims += 1;
      break;
    case "agent.run.complete":
    case "agent.run.error":
      metrics.iterationCount = Math.max(metrics.iterationCount, event.iterationCount);
      break;
    default:
      break;
  }
}

function addUsage(metrics: AgentRunMetricsInternal, usage: TokenUsage | undefined): void {
  if (!usage) {
    return;
  }
  if (typeof usage.promptTokens === "number") {
    metrics.promptTokens = (metrics.promptTokens ?? 0) + usage.promptTokens;
  }
  if (typeof usage.completionTokens === "number") {
    metrics.completionTokens = (metrics.completionTokens ?? 0) + usage.completionTokens;
  }
  if (typeof usage.totalTokens === "number") {
    metrics.totalTokens = (metrics.totalTokens ?? 0) + usage.totalTokens;
  }
  if (typeof usage.costUsd === "number") {
    metrics.costUsd = (metrics.costUsd ?? 0) + usage.costUsd;
  }
}

export interface NdjsonTraceSinkOptions {
  writer: { write(chunk: string): unknown };
  clock?: () => Date;
  includeSummary?: boolean;
  summaryFormatter?: (snapshot: AgentRunSnapshot) => unknown;
  storeEvents?: boolean;
}

export function createNdjsonTraceSink(options: NdjsonTraceSinkOptions) {
  const tracker = createAgentRunTracker({
    clock: options.clock,
    storeEvents: options.storeEvents ?? false,
  });

  return (event: AgentEvent): void => {
    const timestamp = options.clock ? options.clock() : new Date();
    const snapshot = tracker.handle(event, timestamp);
    const record = {
      timestamp: timestamp.toISOString(),
      ...event,
    };
    options.writer.write(`${JSON.stringify(record)}\n`);

    if (snapshot && (options.includeSummary ?? true)) {
      const summaryPayload = options.summaryFormatter
        ? options.summaryFormatter(snapshot)
        : {
            type: "agent.run.summary",
            sessionId: snapshot.sessionId,
            agentId: snapshot.agentId,
            status: snapshot.status,
            startedAt: snapshot.startedAt?.toISOString(),
            completedAt: snapshot.completedAt?.toISOString(),
            elapsedMs: snapshot.elapsedMs,
            metrics: snapshot.metrics,
          };
      options.writer.write(`${JSON.stringify(summaryPayload)}\n`);
    }
  };
}

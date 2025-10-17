import type { MemoryGetContextOptions, MemoryManager, MemoryTurn } from "../memory/types.js";
import type { Tool } from "../tools/types.js";
import type { ToolCache, ToolCacheOptions } from "../core/tool-cache.js";
import type { AgentPolicyConfig, AgentPolicies } from "./policies.js";
import type { AgentQuotaConfig, AgentQuotaManager } from "./quotas.js";
import type { ContextBuilder, ContextBuilderOptions, ContextDigest } from "./context-builder.js";

export type AgentMessageRole = "system" | "user" | "assistant" | "tool";

interface BaseAgentMessage<Role extends AgentMessageRole> {
  role: Role;
}

export interface AgentSystemMessage extends BaseAgentMessage<"system"> {
  content: string;
}

export interface AgentUserMessage extends BaseAgentMessage<"user"> {
  content: string;
}

export interface AgentAssistantMessage extends BaseAgentMessage<"assistant"> {
  content: string;
}

export interface AgentToolMessage extends BaseAgentMessage<"tool"> {
  name: string;
  content: unknown;
}

export type AgentMessage =
  | AgentSystemMessage
  | AgentUserMessage
  | AgentAssistantMessage
  | AgentToolMessage;

export interface AgentMemoryTurn extends MemoryTurn {
  content: AgentMessage;
}

export interface AgentPlanAction {
  tool: string;
  input: unknown;
}

export interface AgentPlanActions {
  actions: AgentPlanAction[];
  final?: undefined;
}

export interface AgentPlanFinal {
  actions?: undefined;
  final: AgentAssistantMessage;
}

export type AgentPlan = AgentPlanActions | AgentPlanFinal;

export type AgentPlannerResult =
  | AgentPlan
  | { actions: Array<{ tool: string; input?: unknown }> }
  | { final: AgentAssistantMessage | string };

export interface PlannerContext<TTurn extends AgentMemoryTurn = AgentMemoryTurn> {
  sessionId: string;
  input: AgentUserMessage;
  context: readonly TTurn[];
  metadata?: Record<string, unknown>;
  iteration: number;
  signal?: AbortSignal;
  prompt?: readonly AgentMessage[];
}

export type Planner<TTurn extends AgentMemoryTurn = AgentMemoryTurn> = (
  context: PlannerContext<TTurn>
) => Promise<AgentPlannerResult> | AgentPlannerResult;

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export type AgentToolCollection =
  | Iterable<Tool>
  | Readonly<Record<string, Tool>>
  | ReadonlyMap<string, Tool>;

export interface AgentConfig<TTurn extends AgentMemoryTurn = AgentMemoryTurn> {
  id?: string;
  metadata?: Record<string, unknown>;
  planner: Planner<TTurn>;
  memory: MemoryManager<TTurn>;
  tools: AgentToolCollection;
  maxIterations?: number;
  maxActionsPerPlan?: number;
  onEvent?: (event: AgentEvent) => void;
  createMemoryTurn?: (message: AgentMessage) => TTurn;
  policies?: AgentPolicies | AgentPolicyConfig;
  quotas?: AgentQuotaManager | AgentQuotaConfig;
  toolCache?: ToolCache | ToolCacheOptions;
}

export interface AgentRunOptions {
  sessionId: string;
  input: AgentUserMessage;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
  context?: MemoryGetContextOptions;
  maxIterations?: number;
}

export interface AgentActionTrace {
  tool: string;
  input: unknown;
  result: unknown;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  cacheHit: boolean;
  audit?: unknown;
}

export interface AgentStepTrace {
  iteration: number;
  plan: AgentPlan;
  actions: AgentActionTrace[];
}

export type AgentErrorCode =
  | "ABORTED"
  | "INVALID_PLAN_FORMAT"
  | "INVALID_PLAN_FINAL"
  | "PLAN_EMPTY_ACTIONS"
  | "MAX_ACTIONS_EXCEEDED"
  | "UNKNOWN_TOOL"
  | "TOOL_EXECUTION_FAILED"
  | "TOOL_NOT_ALLOWED"
  | "TOOL_VALIDATION_FAILED"
  | "QUOTA_EXCEEDED"
  | "MAX_ITERATIONS_EXCEEDED"
  | "UNEXPECTED_ERROR";

export interface AgentErrorOptions {
  cause?: unknown;
  details?: Record<string, unknown>;
}

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: AgentErrorCode, message: string, options?: AgentErrorOptions) {
    super(message);
    if (options?.cause !== undefined) {
      (this as unknown as { cause?: unknown }).cause = options.cause;
    }
    this.name = "AgentError";
    this.code = code;
    this.details = options?.details;
  }
}

export interface AgentRunSuccess {
  status: "completed";
  output: AgentAssistantMessage;
  steps: AgentStepTrace[];
  iterationCount: number;
  elapsedMs: number;
}

export interface AgentRunFailure {
  status: "error";
  error: AgentError;
  steps: AgentStepTrace[];
  iterationCount: number;
  elapsedMs: number;
}

export type AgentRunResult = AgentRunSuccess | AgentRunFailure;

export type AgentEvent =
  | {
      type: "agent.run.start";
      sessionId: string;
      input: AgentUserMessage;
      metadata?: Record<string, unknown>;
      agentId?: string;
    }
  | {
      type: "agent.step.start";
      sessionId: string;
      iteration: number;
      contextTurns: number;
      contextTokens?: number;
      startedAt: Date;
      agentId?: string;
    }
  | {
      type: "agent.plan";
      sessionId: string;
      iteration: number;
      plan: AgentPlan;
      durationMs: number;
      usage?: TokenUsage;
      agentId?: string;
    }
  | {
      type: "agent.tool.start";
      sessionId: string;
      iteration: number;
      action: AgentPlanAction;
      tool: string;
      cached?: boolean;
      agentId?: string;
    }
  | {
      type: "agent.tool.end";
      sessionId: string;
      iteration: number;
      action: AgentPlanAction;
      tool: string;
      result: unknown;
      durationMs: number;
      cached?: boolean;
      audit?: unknown;
      usage?: TokenUsage;
      agentId?: string;
    }
  | {
      type: "agent.tool.error";
      sessionId: string;
      iteration: number;
      action: AgentPlanAction;
      tool: string;
      error: unknown;
      durationMs: number;
      cached?: boolean;
      agentId?: string;
    }
  | {
      type: "agent.tool.blocked";
      sessionId: string;
      iteration: number;
      action: AgentPlanAction;
      tool: string;
      error: AgentError;
      agentId?: string;
    }
  | {
      type: "agent.step.done";
      sessionId: string;
      iteration: number;
      status: "continue" | "final" | "error";
      durationMs: number;
      contextTurns: number;
      contextTokens?: number;
      plan?: AgentPlan;
      actions?: AgentActionTrace[];
      output?: AgentAssistantMessage;
      error?: AgentError;
      agentId?: string;
    }
  | {
      type: "agent.quota.blocked";
      sessionId: string;
      iteration: number;
      action: AgentPlanAction;
      tool: string;
      error: AgentError;
      agentId?: string;
    }
  | {
      type: "agent.run.complete";
      sessionId: string;
      output: AgentAssistantMessage;
      steps: AgentStepTrace[];
      iterationCount: number;
      elapsedMs: number;
      agentId?: string;
    }
  | {
      type: "agent.run.error";
      sessionId: string;
      error: AgentError;
      steps: AgentStepTrace[];
      iterationCount: number;
      elapsedMs: number;
      agentId?: string;
    }
  | {
      type: "agent.memory.append";
      sessionId: string;
      turn: MemoryTurn;
      agentId?: string;
    }
  | {
      type: "agent.memory.summarize";
      sessionId: string;
      agentId?: string;
    }
  | {
      type: "agent.memory.trim";
      sessionId: string;
      retainTurns?: number;
      agentId?: string;
    };

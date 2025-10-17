import { performance } from "node:perf_hooks";
import type { MemoryGetContextOptions, MemoryManager } from "../memory/types.js";
import type { Tool } from "../tools/types.js";
import { ToolCache, type ToolCacheDecision, type ToolCacheOptions, isToolCache } from "../core/tool-cache.js";
import {
  createPolicyManager,
  isAgentPolicies,
  type AgentPolicies,
  type ToolPolicyEvaluation
} from "./policies.js";
import {
  createQuotaManager,
  isAgentQuotaManager,
  type AgentQuotaManager
} from "./quotas.js";
import {
  AgentError,
  type AgentErrorCode,
import type { MemoryGetContextOptions } from "../memory/types.js";
import type { Tool } from "../tools/types.js";
import {
  AgentError,
  type AgentActionTrace,
  type AgentAssistantMessage,
  type AgentConfig,
  type AgentEvent,
  type AgentMemoryTurn,
  type AgentMessage,
  type AgentPlan,
  type AgentPlanAction,
  type AgentRunFailure,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentRunSuccess,
  type AgentStepTrace,
  type AgentToolCollection,
  type AgentShouldStopDecision,
  type AgentShouldStopEvaluator,
  type TokenUsage,
  type AgentUserMessage,
  type AgentContextOptions
} from "./types.js";
import { isFinalPlan, normalizePlan } from "./plan.js";
import { withMemoryEventing } from "../telemetry/events.js";
import { ContextBuilder, type ContextBuildOptions, type ContextDigest } from "./context-builder.js";

const DEFAULT_MAX_ITERATIONS = 8;
const DEFAULT_MAX_ACTIONS = 4;
const DEFAULT_STOP_MESSAGE = "Stopping because a configured stop condition was met.";
const REPEATED_PLAN_MESSAGE =
  "I'm stopping because the planner repeated the same plan twice without progress.";

interface NormalizedStopDecision {
  reason?: string;
  message: AgentAssistantMessage;
}

interface AgentContextDefaults {
  baseMessages?: readonly AgentMessage[];
  ragMessages?: readonly AgentMessage[];
  digests?: readonly ContextDigest[];
  maxRecentTurns?: number;
  maxTokens?: number;
  maxTurns?: number;
}
  type TokenUsage,
  type AgentUserMessage
} from "./types.js";
import { isFinalPlan, normalizePlan } from "./plan.js";
import { withMemoryEventing } from "../telemetry/events.js";
  type AgentUserMessage
} from "./types.js";
import { isFinalPlan, normalizePlan } from "./plan.js";

const DEFAULT_MAX_ITERATIONS = 8;
const DEFAULT_MAX_ACTIONS = 4;

export class Agent<TTurn extends AgentMemoryTurn = AgentMemoryTurn> {
  private readonly tools: Map<string, Tool>;
  private readonly maxIterations: number;
  private readonly maxActionsPerPlan: number;
  private readonly policies?: AgentPolicies;
  private readonly quotas?: AgentQuotaManager;
  private readonly toolCache?: ToolCache;
  private readonly memory: MemoryManager<TTurn>;
  private readonly contextBuilder: ContextBuilder;
  private readonly contextDefaults: AgentContextDefaults;

  constructor(private readonly config: AgentConfig<TTurn>) {
    if (!config) {
      throw new Error("Agent configuration is required");
    }
    if (!config.planner) {
      throw new Error("Agent planner is required");
    }
    if (!config.memory) {
      throw new Error("Agent memory manager is required");
    }
    this.tools = buildToolMap(config.tools);
    this.maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    if (this.maxIterations < 1) {
      throw new Error("maxIterations must be at least 1");
    }
    this.maxActionsPerPlan = config.maxActionsPerPlan ?? DEFAULT_MAX_ACTIONS;
    if (this.maxActionsPerPlan < 1) {
      throw new Error("maxActionsPerPlan must be at least 1");
    }
    this.policies = normalizePolicies(config.policies);
    this.quotas = normalizeQuotas(config.quotas);
    this.toolCache = normalizeToolCache(config.toolCache);
    this.memory = config.onEvent
      ? withMemoryEventing<TTurn>(config.memory, {
          agentId: config.id,
          emit: (event) => this.emit(event),
        })
      : config.memory;
    const contextConfig = config.context ?? {};
    if (contextConfig.builder instanceof ContextBuilder) {
      this.contextBuilder = contextConfig.builder;
    } else {
      this.contextBuilder = new ContextBuilder(contextConfig.builder);
    }
    this.contextDefaults = {
      baseMessages: contextConfig.baseMessages,
      ragMessages: contextConfig.ragMessages,
      digests: contextConfig.digests,
      maxRecentTurns: contextConfig.maxRecentTurns,
      maxTokens: contextConfig.maxTokens,
      maxTurns: contextConfig.maxTurns,
    };
  }

  get id(): string | undefined {
    return this.config.id;
  }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const { sessionId, signal } = options;
    if (!sessionId) {
      throw new AgentError("INVALID_PLAN_FORMAT", "sessionId is required");
    }
    const userInput = normalizeUserMessage(options.input);
    const maxIterations = options.maxIterations ?? this.maxIterations;
    if (maxIterations < 1) {
      throw new AgentError("INVALID_PLAN_FORMAT", "maxIterations must be at least 1");
    }

    const contextOptions: MemoryGetContextOptions | undefined = options.context;
    const mergedMetadata = mergeMetadata(this.config.metadata, options.metadata);
    const steps: AgentStepTrace[] = [];
    const runStart = performance.now();

    throwIfAborted(signal);
    await this.memory.append(sessionId, this.toMemoryTurn(userInput));
    await this.config.memory.append(sessionId, this.toMemoryTurn(userInput));
    this.emit({
      type: "agent.run.start",
      sessionId,
      input: userInput,
      metadata: mergedMetadata,
      agentId: this.id
    });

    let iteration = 0;

    try {
      while (true) {
        throwIfAborted(signal);
        if (iteration >= maxIterations) {
          throw new AgentError("MAX_ITERATIONS_EXCEEDED", `Reached iteration cap of ${maxIterations}`);
        }

        const stepStartedAt = new Date();
        const stepHrStart = performance.now();
        const context = await this.memory.getContext(sessionId, contextOptions);
        const contextStats = summariseContext(context);

        this.emit({
          type: "agent.step.start",
          sessionId,
          iteration,
          contextTurns: contextStats.turns,
          contextTokens: contextStats.tokens,
          startedAt: stepStartedAt,
          agentId: this.id,
        });

        const context = await this.config.memory.getContext(sessionId, contextOptions);
        const planStart = performance.now();
        const plannerResult = await this.config.planner({
          sessionId,
          input: userInput,
          context,
          metadata: mergedMetadata,
          iteration,
          signal
        });
        const planDuration = performance.now() - planStart;
        const planUsage = extractTokenUsage(plannerResult);
        const plan = normalizePlan(plannerResult);
        const planSignature = createPlanSignature(plan);

        this.emit({
          type: "agent.plan",
          sessionId,
          iteration,
          plan,
          durationMs: planDuration,
          usage: planUsage,
          agentId: this.id
        });

        let stepTrace: AgentStepTrace | undefined;
        try {
          stepTrace = { iteration, plan, actions: [] };

          if (isFinalPlan(plan)) {
            const assistantTurn = this.toMemoryTurn(plan.final);
            await this.memory.append(sessionId, assistantTurn);
            steps.push(stepTrace);
            const elapsedMs = performance.now() - stepHrStart;
            this.emit({
              type: "agent.step.done",
              sessionId,
              iteration,
              status: "final",
              durationMs: elapsedMs,
              contextTurns: contextStats.turns,
              contextTokens: contextStats.tokens,
              plan,
              actions: stepTrace.actions,
              output: plan.final,
              agentId: this.id,
            });
            const success = createSuccessResult(steps, runStart, plan.final);
            this.emit({
              type: "agent.run.complete",
              sessionId,
              output: success.output,
              steps: success.steps,
              iterationCount: success.iterationCount,
              elapsedMs: success.elapsedMs,
              agentId: this.id
            });
            return success;
          }

          if (plan.actions.length === 0) {
            throw new AgentError("PLAN_EMPTY_ACTIONS", "Planner returned an empty action list");
          }
          if (plan.actions.length > this.maxActionsPerPlan) {
            throw new AgentError(
              "MAX_ACTIONS_EXCEEDED",
              `Planner returned ${plan.actions.length} actions, exceeding limit of ${this.maxActionsPerPlan}`
            );
          }

          let stopDecision: NormalizedStopDecision | undefined;
          if (planSignature && previousPlanSignature && planSignature === previousPlanSignature) {
            stopDecision = {
              reason: "repeated-plan",
              message: createAssistantMessage(REPEATED_PLAN_MESSAGE),
            };
          } else if (stopEvaluator) {
            const decision = await stopEvaluator({
              sessionId,
              iteration,
              plan,
              metadata: mergedMetadata,
              steps: cloneStepTraces(steps),
            });
            stopDecision = normalizeStopDecision(decision);
          }

          if (stopDecision) {
            const assistantTurn = this.toMemoryTurn(stopDecision.message);
            await this.memory.append(sessionId, assistantTurn);
            steps.push(stepTrace);
            const elapsedMs = performance.now() - stepHrStart;
            this.emit({
              type: "agent.step.done",
              sessionId,
              iteration,
              status: "final",
              durationMs: elapsedMs,
              contextTurns: contextStats.turns,
              contextTokens: contextStats.tokens,
              plan,
              actions: stepTrace.actions,
              output: stopDecision.message,
              agentId: this.id,
            });
            const success = createSuccessResult(steps, runStart, stopDecision.message);
            this.emit({
              type: "agent.run.complete",
              sessionId,
              output: success.output,
              steps: success.steps,
              iterationCount: success.iterationCount,
              elapsedMs: success.elapsedMs,
              agentId: this.id,
            });
            return success;
          }

          previousPlanSignature = planSignature;

          agentId: this.id
        });

        const stepTrace: AgentStepTrace = { iteration, plan, actions: [] };

        if (isFinalPlan(plan)) {
          const assistantTurn = this.toMemoryTurn(plan.final);
          await this.config.memory.append(sessionId, assistantTurn);
          steps.push(stepTrace);
          const success = createSuccessResult(steps, runStart, plan.final);
          this.emit({
            type: "agent.run.complete",
            sessionId,
            output: success.output,
            steps: success.steps,
            iterationCount: success.iterationCount,
            elapsedMs: success.elapsedMs,
            agentId: this.id
          });
          return success;
        }

        if (plan.actions.length === 0) {
          throw new AgentError("PLAN_EMPTY_ACTIONS", "Planner returned an empty action list");
        }
        if (plan.actions.length > this.maxActionsPerPlan) {
          throw new AgentError(
            "MAX_ACTIONS_EXCEEDED",
            `Planner returned ${plan.actions.length} actions, exceeding limit of ${this.maxActionsPerPlan}`
          );
        }

        try {
          for (const action of plan.actions) {
            const trace = await this.executeAction(sessionId, iteration, action, mergedMetadata, signal);
            stepTrace.actions.push(trace);
          }

          steps.push(stepTrace);
          const elapsedMs = performance.now() - stepHrStart;
          this.emit({
            type: "agent.step.done",
            sessionId,
            iteration,
            status: "continue",
            durationMs: elapsedMs,
            contextTurns: contextStats.turns,
            contextTokens: contextStats.tokens,
            plan,
            actions: stepTrace.actions,
            agentId: this.id,
          });
          iteration += 1;
        } catch (error) {
          const agentError = error instanceof AgentError
            ? error
            : new AgentError("UNEXPECTED_ERROR", "Agent step failed", { cause: error });
          const elapsedMs = performance.now() - stepHrStart;
          this.emit({
            type: "agent.step.done",
            sessionId,
            iteration,
            status: "error",
            durationMs: elapsedMs,
            contextTurns: contextStats.turns,
            contextTokens: contextStats.tokens,
            plan: stepTrace?.plan,
            actions: stepTrace?.actions,
            error: agentError,
            agentId: this.id,
          });
          if (stepTrace) {
            steps.push(stepTrace);
          }
          throw agentError;
        }
        } catch (error) {
          steps.push(stepTrace);
          throw error;
        }

        steps.push(stepTrace);
        iteration += 1;
      }
    } catch (error) {
      const agentError = error instanceof AgentError
        ? error
        : new AgentError("UNEXPECTED_ERROR", "Agent run failed", { cause: error });
      const result: AgentRunFailure = {
        status: "error",
        error: agentError,
        steps,
        iterationCount: steps.length,
        elapsedMs: performance.now() - runStart
      };
      this.emit({
        type: "agent.run.error",
        sessionId,
        error: agentError,
        steps,
        iterationCount: result.iterationCount,
        elapsedMs: result.elapsedMs,
        agentId: this.id
      });
      return result;
    }
  }

  private async executeAction(
    sessionId: string,
    iteration: number,
    action: AgentPlanAction,
    metadata: Record<string, unknown> | undefined,
    signal: AbortSignal | undefined
  ): Promise<AgentActionTrace> {
    throwIfAborted(signal);
    const tool = this.tools.get(action.tool);
    if (!tool) {
      throw new AgentError("UNKNOWN_TOOL", `Planner referenced unknown tool "${action.tool}"`);
    }
    const fallbackEvaluation: ToolPolicyEvaluation = {
      action: { tool: action.tool, input: action.input },
      input: action.input
    };
    const blockedAction = sanitizeBlockedAction(action);

    let evaluation = fallbackEvaluation;
    try {
      if (this.policies) {
        evaluation = this.policies.beforeTool({ sessionId, iteration, metadata, action }) ?? fallbackEvaluation;
      }
    } catch (error) {
      const agentError = ensureAgentError(
        error,
        "TOOL_VALIDATION_FAILED",
        `Tool "${tool.name}" blocked by policy`
      );
      this.emit({
        type: "agent.tool.blocked",
        sessionId,
        iteration,
        action: blockedAction,
        tool: tool.name,
        error: agentError,
        agentId: this.id
      });
      throw agentError;
    }

    const actionForEvents = evaluation.action;
    const toolInput = evaluation.input;

    if (this.quotas) {
      const quotaEventAction = this.policies ? actionForEvents : blockedAction;
      try {
        await this.quotas.consume({ sessionId, metadata, tool: tool.name });
      } catch (error) {
        const agentError = ensureAgentError(
          error,
          "QUOTA_EXCEEDED",
          `Quota blocked tool "${tool.name}"`
        );
        this.emit({
          type: "agent.quota.blocked",
          sessionId,
          iteration,
          action: quotaEventAction,
          tool: tool.name,
          error: agentError,
          agentId: this.id
        });
        throw agentError;
      }
    }

    const cacheTtl = determineToolCacheTtl(tool, this.toolCache);
    let cacheDecision: ToolCacheDecision | undefined;
    let cacheHit = false;
    if (this.toolCache && cacheTtl > 0) {
      try {
        cacheDecision = await this.toolCache.prepare({ tool: tool.name, args: toolInput });
        cacheHit = Boolean(cacheDecision.hit);
      } catch (error) {
        console.warn("Tool cache prepare failed", error);
        cacheDecision = { cacheable: false };
      }
    }

      throw new AgentError("UNKNOWN_TOOL", `Planner referenced unknown tool \"${action.tool}\"`);
    }
    const startedAt = new Date();
    const startHr = performance.now();
    this.emit({
      type: "agent.tool.start",
      sessionId,
      iteration,
      action: actionForEvents,
      tool: tool.name,
      cached: cacheHit,
      action,
      tool: tool.name,
      agentId: this.id
    });

    let result: unknown;
    if (cacheHit && cacheDecision?.hit) {
      result = cacheDecision.hit.value;
    } else {
      try {
        result = await tool.run(toolInput, { signal, metadata });
      } catch (error) {
        const durationMs = performance.now() - startHr;
        this.emit({
          type: "agent.tool.error",
          sessionId,
          iteration,
          action: actionForEvents,
          tool: tool.name,
          error,
          durationMs,
          cached: false,
          agentId: this.id
        });
        throw new AgentError("TOOL_EXECUTION_FAILED", `Tool "${tool.name}" failed`, { cause: error });
      }
    try {
      result = await tool.run(action.input, { signal, metadata });
    } catch (error) {
      const durationMs = performance.now() - startHr;
      this.emit({
        type: "agent.tool.error",
        sessionId,
        iteration,
        action,
        tool: tool.name,
        error,
        durationMs,
        agentId: this.id
      });
      throw new AgentError("TOOL_EXECUTION_FAILED", `Tool \"${tool.name}\" failed`, { cause: error });
    }

    const durationMs = performance.now() - startHr;
    const finishedAt = new Date();

    let sanitizedResult = result;
    let auditPayload: unknown | undefined;
    if (this.policies) {
      try {
        const outcome = this.policies.afterTool(
          result,
          { sessionId, iteration, metadata, action: actionForEvents, input: toolInput },
          evaluation
        );
        sanitizedResult = outcome.result;
        auditPayload = outcome.audit;
      } catch (error) {
        const agentError = ensureAgentError(
          error,
          "TOOL_VALIDATION_FAILED",
          `Tool "${tool.name}" result rejected by policy`
        );
        this.emit({
          type: "agent.tool.error",
          sessionId,
          iteration,
          action: actionForEvents,
          tool: tool.name,
          error: agentError,
          durationMs,
          cached: cacheHit,
          agentId: this.id
        });
        throw agentError;
      }
    }

    if (!cacheHit && cacheDecision?.cacheable && this.toolCache && cacheTtl > 0) {
      try {
        await this.toolCache.write(cacheDecision, sanitizedResult, cacheTtl);
      } catch (error) {
        console.warn("Tool cache write failed", error);
      }
    }

    this.emit({
      type: "agent.tool.end",
      sessionId,
      iteration,
      action: actionForEvents,
      tool: tool.name,
      result: sanitizedResult,
      durationMs,
      cached: cacheHit,
      audit: auditPayload,
      agentId: this.id
    });

    const observation = this.toMemoryTurn({ role: "tool", name: tool.name, content: sanitizedResult });
    await this.memory.append(sessionId, observation);

    return {
      tool: tool.name,
      input: actionForEvents.input,
      result: sanitizedResult,
      startedAt,
      finishedAt,
      durationMs,
      cacheHit,
      audit: auditPayload
      action,
      tool: tool.name,
      result,
      durationMs,
      agentId: this.id
    });

    const observation = this.toMemoryTurn({ role: "tool", name: tool.name, content: result });
    await this.config.memory.append(sessionId, observation);

    return {
      tool: tool.name,
      input: action.input,
      result,
      startedAt,
      finishedAt,
      durationMs
    };
  }

  private toMemoryTurn(message: AgentMessage): TTurn {
    const factory = this.config.createMemoryTurn ?? defaultTurnFactory<TTurn>;
    return factory(message);
  }

  private emit(event: AgentEvent): void {
    if (!this.config.onEvent) return;
    try {
      this.config.onEvent(event);
    } catch (error) {
      // Swallow event handler errors to avoid destabilising the agent loop.
      console.error("Agent event handler threw", error);
    }
  }
}

function buildToolMap(collection: AgentToolCollection): Map<string, Tool> {
  if (!collection) {
    throw new Error("Agent requires a tool collection");
  }
  const tools = new Map<string, Tool>();
  const register = (tool: Tool, explicitName?: string) => {
    if (!tool || typeof tool.name !== "string" || tool.name.trim() === "") {
      throw new Error("Each tool must specify a non-empty name");
    }
    const key = tool.name;
    if (explicitName && explicitName !== key) {
      throw new Error(`Tool name mismatch: key \"${explicitName}\" vs tool.name \"${tool.name}\"`);
    }
    if (tools.has(key)) {
      throw new Error(`Duplicate tool registered: ${key}`);
    }
    tools.set(key, tool);
  };

  if (collection instanceof Map) {
    for (const [name, tool] of collection.entries()) {
      register(tool, name);
    }
    return tools;
  }

  if (typeof (collection as Iterable<Tool>)[Symbol.iterator] === "function") {
    for (const tool of collection as Iterable<Tool>) {
      register(tool);
    }
    return tools;
  }

  if (typeof collection === "object") {
    for (const [name, tool] of Object.entries(collection as Record<string, Tool>)) {
      register(tool, name);
    }
    return tools;
  }

  throw new Error("Unsupported tool collection type");
}

function normalizeUserMessage(message: AgentUserMessage): AgentUserMessage {
  if (!message || message.role !== "user" || typeof message.content !== "string") {
    throw new AgentError("INVALID_PLAN_FORMAT", "Agent run input must be a user message with string content");
  }
  return message;
}

function createSuccessResult(
  steps: AgentStepTrace[],
  runStart: number,
  final: AgentAssistantMessage
): AgentRunSuccess {
  return {
    status: "completed",
    output: final,
    steps,
    iterationCount: steps.length,
    elapsedMs: performance.now() - runStart
  };
}

function normalizeStopDecision(
  decision: AgentShouldStopDecision | undefined
): NormalizedStopDecision | undefined {
  if (decision === undefined || decision === null || decision === false) {
    return undefined;
  }
  if (decision === true) {
    return { message: createAssistantMessage(DEFAULT_STOP_MESSAGE) };
  }
  if (typeof decision === "string") {
    return { message: createAssistantMessage(decision) };
  }
  if (isAssistantMessage(decision)) {
    return { message: decision };
  }
  if (typeof decision === "object") {
    const shouldStop = decision.stop ?? true;
    if (!shouldStop) {
      return undefined;
    }
    const messageValue = decision.message;
    const message = isAssistantMessage(messageValue)
      ? messageValue
      : typeof messageValue === "string"
        ? createAssistantMessage(messageValue)
        : createAssistantMessage(DEFAULT_STOP_MESSAGE);
    const normalized: NormalizedStopDecision = { message };
    if (typeof decision.reason === "string" && decision.reason.trim() !== "") {
      normalized.reason = decision.reason;
    }
    return normalized;
  }
  return undefined;
}

function createAssistantMessage(content: string): AgentAssistantMessage {
  return { role: "assistant", content };
}

function isAssistantMessage(value: unknown): value is AgentAssistantMessage {
  return (
    !!value &&
    typeof value === "object" &&
    (value as AgentAssistantMessage).role === "assistant" &&
    typeof (value as AgentAssistantMessage).content === "string"
  );
}

function cloneStepTraces(steps: AgentStepTrace[]): readonly AgentStepTrace[] {
  const snapshot = steps.map((step) => ({
    iteration: step.iteration,
    plan: step.plan,
    actions: step.actions.map((action) => ({ ...action })),
  }));
  return snapshot as readonly AgentStepTrace[];
}

function createPlanSignature(plan: AgentPlan): string | undefined {
  try {
    return stablePlanStringify(plan);
  } catch {
    return undefined;
  }
}

function stablePlanStringify(value: unknown, stack = new Set<unknown>()): string {
  if (value === null) {
    return "null";
  }
  const type = typeof value;
  if (type === "number" || type === "boolean") {
    return JSON.stringify(value);
  }
  if (type === "string") {
    return JSON.stringify(value);
  }
  if (type === "bigint") {
    return JSON.stringify((value as bigint).toString());
  }
  if (type === "undefined") {
    return "undefined";
  }
  if (type === "symbol" || type === "function") {
    return JSON.stringify(String(value));
  }
  if (Array.isArray(value)) {
    if (stack.has(value)) {
      return JSON.stringify("[Circular]");
    }
    stack.add(value);
    const items = value.map((entry) => stablePlanStringify(entry, stack));
    stack.delete(value);
    return `[${items.join(",")}]`;
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (value instanceof RegExp) {
    return JSON.stringify(value.toString());
  }
  if (value instanceof Set) {
    if (stack.has(value)) {
      return JSON.stringify("[Circular Set]");
    }
    stack.add(value);
    const items = Array.from(value)
      .map((entry) => stablePlanStringify(entry, stack))
      .sort();
    stack.delete(value);
    return `{set:[${items.join(",")}]}`;
  }
  if (value instanceof Map) {
    if (stack.has(value)) {
      return JSON.stringify("[Circular Map]");
    }
    stack.add(value);
    const entries = Array.from(value.entries())
      .map(([key, val]) => [stablePlanStringify(key, stack), stablePlanStringify(val, stack)] as const)
      .sort(([keyA], [keyB]) => keyA.localeCompare(keyB));
    stack.delete(value);
    const content = entries.map(([key, val]) => `${key}:${val}`).join(",");
    return `{map:{${content}}}`;
  }
  if (type === "object") {
    if (stack.has(value as object)) {
      return JSON.stringify("[Circular]");
    }
    stack.add(value as object);
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stablePlanStringify((value as Record<string, unknown>)[key], stack)}`);
    stack.delete(value as object);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function buildMemoryContextOptions(
  overrides: AgentContextOptions | undefined,
  defaults: AgentContextDefaults
): MemoryGetContextOptions | undefined {
  const maxTokensCandidate = overrides?.maxTokens ?? defaults.maxTokens;
  const maxTurnsCandidate = overrides?.maxTurns ?? defaults.maxTurns;

  const options: MemoryGetContextOptions = {};

  if (isPositiveNumber(maxTokensCandidate)) {
    options.maxTokens = maxTokensCandidate;
  }
  if (isPositiveNumber(maxTurnsCandidate)) {
    options.maxTurns = Math.floor(maxTurnsCandidate);
  }

  return Object.keys(options).length > 0 ? options : undefined;
}

function determineContextBudget(
  preferred: number | undefined,
  turns: readonly AgentMemoryTurn[]
): number {
  if (isPositiveNumber(preferred)) {
    return preferred;
  }

  let total = 0;
  for (const turn of turns) {
    const tokens = turn.tokens;
    if (isPositiveNumber(tokens)) {
      total += tokens;
    }
  }

  if (total > 0) {
    return total;
  }

  const heuristic = Math.max(512, turns.length * 256);
  return heuristic > 0 ? heuristic : 512;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function summariseContext(
  context: readonly AgentMemoryTurn[],
  promptTokens?: number
): { turns: number; tokens?: number } {
  let totalTokens: number | undefined;
  if (isPositiveNumber(promptTokens)) {
    totalTokens = promptTokens;
  } else {
    for (const turn of context) {
      const tokens = turn.tokens;
      if (isPositiveNumber(tokens)) {
        totalTokens = (totalTokens ?? 0) + tokens;
      }
    }
  }
  return { turns: context.length, tokens: totalTokens };
}

function extractTokenUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const usage = (value as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const candidate = usage as Record<string, unknown>;
  const normalized: TokenUsage = {};
  if (typeof candidate.promptTokens === "number") {
    normalized.promptTokens = candidate.promptTokens;
  }
  if (typeof candidate.completionTokens === "number") {
    normalized.completionTokens = candidate.completionTokens;
  }
  if (typeof candidate.totalTokens === "number") {
    normalized.totalTokens = candidate.totalTokens;
  }
  if (typeof candidate.costUsd === "number") {
    normalized.costUsd = candidate.costUsd;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function defaultTurnFactory<TTurn extends AgentMemoryTurn>(message: AgentMessage): TTurn {
  const turn: AgentMemoryTurn = {
    role: message.role,
    content: message,
    createdAt: new Date()
  };
  return turn as TTurn;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal) return;
  if (signal.aborted) {
    const reason = signal.reason ?? "aborted";
    const description = typeof reason === "string" ? reason : "Agent run aborted";
    throw new AgentError("ABORTED", description, { cause: reason });
  }
}

function mergeMetadata(
  base: Record<string, unknown> | undefined,
  override: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!base && !override) {
    return undefined;
  }
  return { ...(base ?? {}), ...(override ?? {}) };
}

function normalizePolicies(
  policies: AgentConfig["policies"]
): AgentPolicies | undefined {
  if (!policies) {
    return undefined;
  }
  if (isAgentPolicies(policies)) {
    return policies;
  }
  return createPolicyManager(policies);
}

function normalizeQuotas(quotas: AgentConfig["quotas"]): AgentQuotaManager | undefined {
  if (!quotas) {
    return undefined;
  }
  if (isAgentQuotaManager(quotas)) {
    return quotas;
  }
  return createQuotaManager(quotas);
}

function normalizeToolCache(toolCache: AgentConfig["toolCache"]): ToolCache | undefined {
  if (!toolCache) {
    return undefined;
  }
  if (isToolCache(toolCache)) {
    return toolCache;
  }
  return new ToolCache(toolCache as ToolCacheOptions);
}

function determineToolCacheTtl(tool: Tool, cache: ToolCache | undefined): number {
  if (!cache) {
    return 0;
  }
  const ttl = typeof tool.cacheTtlSec === "number" ? tool.cacheTtlSec : 0;
  return ttl > 0 ? ttl : 0;
}

function sanitizeBlockedAction(action: AgentPlanAction): AgentPlanAction {
  return { tool: action.tool, input: undefined };
}

function ensureAgentError(
  error: unknown,
  fallbackCode: AgentErrorCode,
  fallbackMessage: string
): AgentError {
  if (error instanceof AgentError) {
    return error;
  }
  return new AgentError(fallbackCode, fallbackMessage, { cause: error });
}

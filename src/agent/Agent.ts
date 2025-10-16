import { performance } from "node:perf_hooks";
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
  type AgentUserMessage
} from "./types.js";
import { isFinalPlan, normalizePlan } from "./plan.js";

const DEFAULT_MAX_ITERATIONS = 8;
const DEFAULT_MAX_ACTIONS = 4;

export class Agent<TTurn extends AgentMemoryTurn = AgentMemoryTurn> {
  private readonly tools: Map<string, Tool>;
  private readonly maxIterations: number;
  private readonly maxActionsPerPlan: number;

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
        const plan = normalizePlan(plannerResult);

        this.emit({
          type: "agent.plan",
          sessionId,
          iteration,
          plan,
          durationMs: planDuration,
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
      throw new AgentError("UNKNOWN_TOOL", `Planner referenced unknown tool \"${action.tool}\"`);
    }
    const startedAt = new Date();
    const startHr = performance.now();
    this.emit({
      type: "agent.tool.start",
      sessionId,
      iteration,
      action,
      tool: tool.name,
      agentId: this.id
    });

    let result: unknown;
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

    this.emit({
      type: "agent.tool.end",
      sessionId,
      iteration,
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

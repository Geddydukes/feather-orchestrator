import { agentMessagesToMessages, turnsToMessages } from "./history.js";
import { normalizePlan } from "./plan.js";
import type {
  AgentMemoryTurn,
  AgentPlan,
  AgentPlannerResult,
  Planner,
  PlannerContext,
} from "./types.js";
import type { Message } from "../types.js";

export interface PlannerModelCallConfig {
  messages: Message[];
  signal?: AbortSignal;
  /**
   * Arbitrary metadata passed through from the agent run. This can be used by
   * provider implementations for tracing or additional routing logic.
   */
  metadata?: Record<string, unknown>;
  /**
   * Static configuration passed to each model invocation (e.g. provider/model
   * identifiers or decoding parameters).
   */
  config?: Record<string, unknown>;
}

export type PlannerModelCaller = (
  input: PlannerModelCallConfig
) => Promise<string | { content: string }>;

export interface PlannerToolDescription {
  name: string;
  description: string;
  inputSchema?: unknown;
}

export interface PlannerFallbackContext<TTurn extends AgentMemoryTurn = AgentMemoryTurn> {
  error: PlannerOutputParseError;
  rawText: string;
  plannerContext: PlannerContext<TTurn>;
}

export type PlannerFallback<TTurn extends AgentMemoryTurn = AgentMemoryTurn> = (
  context: PlannerFallbackContext<TTurn>
) => AgentPlan;

export interface CreateJsonPlannerOptions<TTurn extends AgentMemoryTurn = AgentMemoryTurn> {
  callModel: PlannerModelCaller;
  tools: Iterable<PlannerToolDescription>;
  systemPrompt?: string;
  /**
   * Additional static configuration forwarded to the underlying model caller
   * for every plan request.
   */
  modelConfig?: Record<string, unknown>;
  /** Optional hook invoked when the planner output cannot be parsed. */
  onError?: (error: PlannerOutputParseError, context: PlannerContext<TTurn>) => void;
  /** Fallback plan returned when parsing fails. */
  fallback?: PlannerFallback<TTurn>;
}

export const DEFAULT_PLANNER_SYSTEM_PROMPT = [
  "You are the planner for a Feather agent.",
  "Review the conversation and decide the agent's next step.",
  "Respond with strictly valid JSON and nothing else.",
  'Valid outputs: {"actions":[{"tool":"name","input":{...}}, ...]} or {"final":{"role":"assistant","content":"..."}}.',
  "Select tools only when they will produce information required to answer the user.",
  "If the assistant can respond directly, return a {\"final\"} plan.",
].join(" ");

const DEFAULT_FALLBACK_MESSAGE =
  "I'm sorry, but I couldn't determine the next action. Could you clarify what you need?";

export function createJsonPlanner<TTurn extends AgentMemoryTurn = AgentMemoryTurn>(
  options: CreateJsonPlannerOptions<TTurn>
): Planner<TTurn> {
  if (!options || typeof options !== "object") {
    throw new Error("createJsonPlanner requires an options object");
  }
  const { callModel } = options;
  if (typeof callModel !== "function") {
    throw new Error("createJsonPlanner requires a callModel function");
  }

  const toolList = Array.from(options.tools ?? []);
  const toolInstructions = buildToolInstructions(toolList);
  const systemPrompt = options.systemPrompt?.trim() || DEFAULT_PLANNER_SYSTEM_PROMPT;
  const fallback = options.fallback ?? defaultFallback;

  return async (context) => {
    let historyMessages = context.prompt
      ? agentMessagesToMessages(context.prompt)
      : turnsToMessages(context.context);
    if (historyMessages.length === 0) {
      historyMessages = [{ role: context.input.role, content: context.input.content }];
    }

    const messages: Message[] = [
      { role: "system", content: systemPrompt },
      { role: "system", content: toolInstructions },
      ...historyMessages,
    ];

    const response = await callModel({
      messages,
      signal: context.signal,
      metadata: context.metadata,
      config: options.modelConfig,
    });

    const text = extractContent(response);

    try {
      const jsonText = extractFirstJsonObject(text);
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonText) as unknown;
      } catch (parseError) {
        throw createPlannerParseError("invalid-json", jsonText, parseError);
      }
      const plan = normalizePlan(parsed as AgentPlannerResult);
      return plan;
    } catch (error) {
      const parseError =
        error instanceof PlannerOutputParseError
          ? error
          : createPlannerParseError("invalid-structure", text, error);
      options.onError?.(parseError, context);
      return fallback({ error: parseError, rawText: text, plannerContext: context });
    }
  };
}

export class PlannerOutputParseError extends Error {
  constructor(
    public readonly kind: "missing-json" | "invalid-json" | "invalid-structure",
    public readonly rawText: string,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message);
    if (options?.cause !== undefined) {
      (this as unknown as { cause?: unknown }).cause = options.cause;
    }
    this.name = "PlannerOutputParseError";
  }
}

function buildToolInstructions(tools: PlannerToolDescription[]): string {
  if (tools.length === 0) {
    return "No tools available. You must respond with a final answer.";
  }

  const toolLines = tools.map((tool) => {
    const schema = tool.inputSchema ? `\nInput schema: ${stringify(tool.inputSchema)}` : "";
    return `- ${tool.name}: ${tool.description}${schema}`;
  });
  return [
    "Tools you may call (return `actions` to invoke one or more tools):",
    ...toolLines,
    "If no tool is appropriate, return {\"final\":{...}}.",
  ].join("\n");
}

function extractContent(result: string | { content: string }): string {
  if (typeof result === "string") {
    return result;
  }
  if (result && typeof result.content === "string") {
    return result.content;
  }
  throw new PlannerOutputParseError(
    "invalid-structure",
    String(result),
    "Planner model returned an unsupported response payload"
  );
}

function extractFirstJsonObject(text: string): string {
  const trimmed = text.trim();
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char === "}") {
      if (depth === 0) {
        continue;
      }
      depth -= 1;
      if (depth === 0 && start !== -1) {
        return trimmed.slice(start, index + 1);
      }
    }
  }

  throw createPlannerParseError("missing-json", text);
}

function defaultFallback(): AgentPlan {
  return {
    final: {
      role: "assistant",
      content: DEFAULT_FALLBACK_MESSAGE,
    },
  };
}

function createPlannerParseError(
  kind: "missing-json" | "invalid-json" | "invalid-structure",
  rawText: string,
  cause?: unknown
): PlannerOutputParseError {
  const message =
    kind === "missing-json"
      ? "Planner response did not contain valid JSON"
      : kind === "invalid-json"
        ? "Planner returned malformed JSON"
        : "Planner response could not be normalised";
  return new PlannerOutputParseError(kind, rawText, message, { cause });
}

function stringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch (error) {
    return String(value);
  }
}

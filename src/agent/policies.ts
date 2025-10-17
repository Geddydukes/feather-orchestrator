import { AgentError, type AgentPlanAction } from "./types.js";

export interface ToolSchema {
  safeParse(input: unknown):
    | { success: true; data: unknown }
    | { success: false; error: { issues?: unknown } };
}

export interface ToolPolicyContext {
  sessionId: string;
  iteration: number;
  metadata?: Record<string, unknown>;
}

export interface ToolPolicyRunContext extends ToolPolicyContext {
  action: AgentPlanAction;
}

export interface ToolPolicyResultContext extends ToolPolicyContext {
  input: unknown;
  action: AgentPlanAction;
}

export interface ToolPolicyDefinition {
  tool: string;
  schema?: ToolSchema;
  validate?: (input: unknown, context: ToolPolicyRunContext) => void;
  redactInput?: (input: unknown, context: ToolPolicyRunContext) => unknown;
  redactResult?: (result: unknown, context: ToolPolicyResultContext) => unknown;
  audit?: (result: unknown, context: ToolPolicyResultContext) => unknown;
}

export interface AgentPolicyConfig {
  allowedTools?: readonly string[];
  toolPolicies?: readonly ToolPolicyDefinition[];
}

export interface ToolPolicyEvaluation {
  action: AgentPlanAction;
  input: unknown;
  policy?: InternalToolPolicy;
}

export interface ToolPolicyOutcome {
  result: unknown;
  audit?: unknown;
}

export interface AgentPolicies {
  beforeTool(context: ToolPolicyRunContext): ToolPolicyEvaluation;
  afterTool(result: unknown, context: ToolPolicyResultContext, evaluation: ToolPolicyEvaluation): ToolPolicyOutcome;
}

export function isAgentPolicies(value: unknown): value is AgentPolicies {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<AgentPolicies>;
  return typeof candidate.beforeTool === "function" && typeof candidate.afterTool === "function";
}

export function createPolicyManager(config: AgentPolicyConfig): AgentPolicies {
  return new AgentPolicyManager(config);
}

interface InternalToolPolicy extends ToolPolicyDefinition {
  tool: string;
}

class AgentPolicyManager implements AgentPolicies {
  private readonly allowedTools?: Set<string>;
  private readonly toolPolicies: Map<string, InternalToolPolicy>;

  constructor(config: AgentPolicyConfig) {
    this.allowedTools = config.allowedTools ? new Set(config.allowedTools) : undefined;
    this.toolPolicies = new Map();
    for (const definition of config.toolPolicies ?? []) {
      if (!definition || typeof definition.tool !== "string" || definition.tool.trim() === "") {
        throw new Error("Each tool policy must specify a non-empty tool name");
      }
      const key = definition.tool;
      if (this.toolPolicies.has(key)) {
        throw new Error(`Duplicate policy registered for tool \"${key}\"`);
      }
      this.toolPolicies.set(key, { ...definition, tool: key });
    }
  }

  beforeTool(context: ToolPolicyRunContext): ToolPolicyEvaluation {
    const { action } = context;
    this.assertAllowed(action.tool);
    const policy = this.toolPolicies.get(action.tool);
    if (!policy) {
      return createEvaluation(action, action.input);
    }

    let parsedInput = action.input;
    if (policy.schema) {
      const parsed = policy.schema.safeParse(action.input);
      if (!parsed.success) {
        throw new AgentError("TOOL_VALIDATION_FAILED", `Tool \"${action.tool}\" input failed validation`, {
          details: { issues: parsed.error.issues ?? parsed.error }
        });
      }
      parsedInput = parsed.data;
    }

    if (policy.validate) {
      try {
        policy.validate(parsedInput, context);
      } catch (error) {
        throw toAgentError(
          error,
          "TOOL_VALIDATION_FAILED",
          `Tool \"${action.tool}\" input rejected by custom validator`
        );
      }
    }

    const sanitizedInput = policy.redactInput
      ? safelyRedactInput(policy, parsedInput, context)
      : parsedInput;

    return {
      action: cloneAction(action, sanitizedInput),
      input: parsedInput,
      policy
    };
  }

  afterTool(result: unknown, context: ToolPolicyResultContext, evaluation: ToolPolicyEvaluation): ToolPolicyOutcome {
    const policy = evaluation.policy;
    if (!policy) {
      return { result };
    }

    const sanitized = policy.redactResult ? safelyRedactResult(policy, result, context) : result;
    const audit = policy.audit ? safelyAuditResult(policy, sanitized, context) : undefined;
    return audit === undefined ? { result: sanitized } : { result: sanitized, audit };
  }

  private assertAllowed(tool: string): void {
    if (this.allowedTools && !this.allowedTools.has(tool)) {
      throw new AgentError("TOOL_NOT_ALLOWED", `Tool \"${tool}\" is not permitted by policy`);
    }
  }
}

function createEvaluation(action: AgentPlanAction, input: unknown): ToolPolicyEvaluation {
  return { action: cloneAction(action, input), input };
}

function cloneAction(action: AgentPlanAction, input: unknown): AgentPlanAction {
  return { tool: action.tool, input };
}

function safelyRedactInput(
  policy: InternalToolPolicy,
  input: unknown,
  context: ToolPolicyRunContext
): unknown {
  try {
    return policy.redactInput!(input, context);
  } catch (error) {
    throw toAgentError(
      error,
      "TOOL_VALIDATION_FAILED",
      `Tool \"${context.action.tool}\" input redaction failed`
    );
  }
}

function safelyRedactResult(
  policy: InternalToolPolicy,
  result: unknown,
  context: ToolPolicyResultContext
): unknown {
  try {
    return policy.redactResult!(result, context);
  } catch (error) {
    throw toAgentError(
      error,
      "TOOL_VALIDATION_FAILED",
      `Tool \"${context.action.tool}\" result redaction failed`
    );
  }
}

function safelyAuditResult(
  policy: InternalToolPolicy,
  result: unknown,
  context: ToolPolicyResultContext
): unknown {
  try {
    return policy.audit!(result, context);
  } catch (error) {
    throw toAgentError(
      error,
      "TOOL_VALIDATION_FAILED",
      `Tool \"${context.action.tool}\" audit hook failed`
    );
  }
}

function toAgentError(error: unknown, code: "TOOL_VALIDATION_FAILED", message: string): AgentError {
  if (error instanceof AgentError) {
    return error;
  }
  return new AgentError(code, message, { cause: error });
}

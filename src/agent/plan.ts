import {
  AgentError,
  type AgentAssistantMessage,
  type AgentPlan,
  type AgentPlanAction,
  type AgentPlanFinal,
  type AgentPlannerResult,
} from "./types.js";

export function normalizePlan(result: AgentPlannerResult): AgentPlan {
  if (!result || typeof result !== "object") {
    throw new AgentError("INVALID_PLAN_FORMAT", "Planner must return an object");
  }

  if ("final" in result) {
    const final = (result as { final?: AgentAssistantMessage | string }).final;
    if (final === undefined) {
      throw new AgentError("INVALID_PLAN_FINAL", "Planner returned a final plan without content");
    }
    return { final: normalizeAssistantMessage(final) };
  }

  if (!Array.isArray((result as { actions?: unknown }).actions)) {
    throw new AgentError("INVALID_PLAN_FORMAT", "Planner must return either {final} or {actions}");
  }

  const actions = (result as { actions: Array<{ tool: string; input?: unknown }> }).actions.map((action, index) => {
    if (!action || typeof action.tool !== "string" || action.tool.trim() === "") {
      throw new AgentError(
        "INVALID_PLAN_FORMAT",
        `Plan action at index ${index} is missing a valid tool name`
      );
    }
    return { tool: action.tool, input: action.input } satisfies AgentPlanAction;
  });

  return { actions } satisfies AgentPlan;
}

export function normalizeAssistantMessage(message: AgentAssistantMessage | string): AgentAssistantMessage {
  if (typeof message === "string") {
    return { role: "assistant", content: message };
  }
  if (!message || message.role !== "assistant" || typeof message.content !== "string") {
    throw new AgentError("INVALID_PLAN_FINAL", "Final plan output must be an assistant message or string");
  }
  return message;
}

export function isFinalPlan(plan: AgentPlan): plan is AgentPlanFinal {
  return "final" in plan;
}

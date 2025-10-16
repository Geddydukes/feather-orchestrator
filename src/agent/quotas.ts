import { AgentError } from "./types.js";

export interface AgentQuotaContext {
  sessionId: string;
  metadata?: Record<string, unknown>;
  tool?: string;
}

export type AgentQuotaScope = "session" | "user" | "global";

export interface AgentQuotaRuleConfig {
  name: string;
  limit: number;
  intervalMs: number;
  scope: AgentQuotaScope;
  metadataKey?: string;
  includeTool?: boolean;
  key?: (context: AgentQuotaContext) => string | undefined;
}

export interface AgentQuotaConfig {
  rules: readonly AgentQuotaRuleConfig[];
}

export interface AgentQuotaManager {
  consume(context: AgentQuotaContext): void | Promise<void>;
}

export function isAgentQuotaManager(value: unknown): value is AgentQuotaManager {
  if (!value || typeof value !== "object") {
    return false;
  }
  return typeof (value as AgentQuotaManager).consume === "function";
}

export function createQuotaManager(config: AgentQuotaConfig): AgentQuotaManager {
  return new InMemoryQuotaManager(config);
}

interface CounterState {
  count: number;
  resetAt: number;
}

export class InMemoryQuotaManager implements AgentQuotaManager {
  private readonly rules: readonly AgentQuotaRuleConfig[];
  private readonly counters = new Map<string, CounterState>();

  constructor(config: AgentQuotaConfig) {
    if (!config || !Array.isArray(config.rules) || config.rules.length === 0) {
      throw new Error("Quota configuration must include at least one rule");
    }
    this.rules = [...config.rules];
    for (const rule of this.rules) {
      validateRule(rule);
    }
  }

  consume(context: AgentQuotaContext): void {
    const now = Date.now();
    for (const rule of this.rules) {
      const key = resolveKey(rule, context);
      if (!key) {
        continue;
      }
      const compositeKey = `${rule.name}:${key}`;
      const current = this.counters.get(compositeKey);
      if (!current || current.resetAt <= now) {
        this.counters.set(compositeKey, {
          count: 1,
          resetAt: now + rule.intervalMs
        });
        continue;
      }
      if (current.count >= rule.limit) {
        throw new AgentError("QUOTA_EXCEEDED", `Quota \"${rule.name}\" exceeded for key ${key}`, {
          details: {
            rule: rule.name,
            limit: rule.limit,
            intervalMs: rule.intervalMs,
            key
          }
        });
      }
      current.count += 1;
    }
  }
}

function validateRule(rule: AgentQuotaRuleConfig): void {
  if (!rule.name || typeof rule.name !== "string") {
    throw new Error("Quota rule requires a name");
  }
  if (!Number.isFinite(rule.limit) || rule.limit <= 0) {
    throw new Error(`Quota rule \"${rule.name}\" must specify a positive limit`);
  }
  if (!Number.isFinite(rule.intervalMs) || rule.intervalMs <= 0) {
    throw new Error(`Quota rule \"${rule.name}\" must specify a positive intervalMs`);
  }
  if (!rule.scope && !rule.key) {
    throw new Error(`Quota rule \"${rule.name}\" must provide a scope or key resolver`);
  }
}

function resolveKey(rule: AgentQuotaRuleConfig, context: AgentQuotaContext): string | undefined {
  if (rule.key) {
    return rule.key(context);
  }

  switch (rule.scope) {
    case "session": {
      const base = context.sessionId;
      if (!base) return undefined;
      return appendTool(base, context.tool, rule.includeTool);
    }
    case "user": {
      const key = rule.metadataKey ?? "userId";
      const raw = context.metadata?.[key];
      if (raw === undefined || raw === null) {
        return undefined;
      }
      const identifier = stringifyIdentifier(raw);
      if (!identifier) {
        return undefined;
      }
      return appendTool(identifier, context.tool, rule.includeTool);
    }
    case "global": {
      return appendTool("global", context.tool, rule.includeTool);
    }
    default:
      return undefined;
  }
}

function appendTool(base: string, tool: string | undefined, includeTool: boolean | undefined): string {
  if (!includeTool || !tool) {
    return base;
  }
  return `${base}:${tool}`;
}

function stringifyIdentifier(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() === "" ? undefined : value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

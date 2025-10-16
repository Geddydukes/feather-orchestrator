import { AgentError } from "./types.js";
import {
  type AgentQuotaConfig,
  type AgentQuotaContext,
  type AgentQuotaManager,
  type AgentQuotaRuleConfig,
} from "./quotas.js";

export interface RedisRateLimiterClient {
  eval?(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  evalSha?(sha: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  scriptLoad?(script: string): Promise<string>;
  incr?(key: string): Promise<number>;
  pExpire?(key: string, ttlMs: number): Promise<number>;
}

export interface RedisQuotaManagerOptions {
  client: RedisRateLimiterClient;
  namespace?: string;
}

const RATE_LIMIT_SCRIPT = `
local key = KEYS[1]
local ttlMs = tonumber(ARGV[1]) or 0
local limit = tonumber(ARGV[2]) or 0
local current = redis.call('INCR', key)
if current == 1 and ttlMs > 0 then
  redis.call('PEXPIRE', key, ttlMs)
end
if current > limit and limit > 0 then
  return {current, 0}
end
return {current, 1}
`;

interface ScriptResult {
  count: number;
  allowed: boolean;
}

export class RedisQuotaManager implements AgentQuotaManager {
  private readonly client: RedisRateLimiterClient;
  private readonly namespace?: string;
  private readonly rules: readonly AgentQuotaRuleConfig[];
  private scriptSha?: string;

  constructor(config: AgentQuotaConfig, options: RedisQuotaManagerOptions) {
    if (!options || !options.client) {
      throw new Error("RedisQuotaManager requires a Redis client");
    }

    if (!config || !Array.isArray(config.rules) || config.rules.length === 0) {
      throw new Error("Quota configuration must include at least one rule");
    }

    this.client = options.client;
    this.namespace = options.namespace;
    this.rules = [...config.rules];

    for (const rule of this.rules) {
      validateRule(rule);
    }
  }

  async consume(context: AgentQuotaContext): Promise<void> {
    for (const rule of this.rules) {
      const key = resolveKey(rule, context);
      if (!key) {
        continue;
      }

      const redisKey = this.buildRedisKey(rule.name, key);
      const result = await this.runRule(redisKey, rule.intervalMs, rule.limit);
      if (!result.allowed) {
        throw new AgentError("QUOTA_EXCEEDED", `Quota "${rule.name}" exceeded for key ${key}`, {
          details: {
            rule: rule.name,
            limit: rule.limit,
            intervalMs: rule.intervalMs,
            key,
            count: result.count,
          }
        });
      }
    }
  }

  private async runRule(key: string, intervalMs: number, limit: number): Promise<ScriptResult> {
    const args = [String(intervalMs), String(limit)];

    if (this.client.evalSha && this.scriptSha) {
      try {
        const response = await this.client.evalSha(this.scriptSha, { keys: [key], arguments: args });
        return parseScriptResponse(response);
      } catch (error) {
        const message = (error as Error).message ?? "";
        if (!message.includes("NOSCRIPT")) {
          throw error;
        }
      }
    }

    if (this.client.scriptLoad) {
      this.scriptSha = await this.client.scriptLoad(RATE_LIMIT_SCRIPT);
      if (this.client.evalSha) {
        const response = await this.client.evalSha(this.scriptSha, { keys: [key], arguments: args });
        return parseScriptResponse(response);
      }
    }

    if (this.client.eval) {
      const response = await this.client.eval(RATE_LIMIT_SCRIPT, { keys: [key], arguments: args });
      return parseScriptResponse(response);
    }

    if (!this.client.incr) {
      throw new Error("Redis client must support EVAL or INCR for quotas");
    }

    const count = await this.client.incr(key);
    if (count === 1 && this.client.pExpire && intervalMs > 0) {
      await this.client.pExpire(key, intervalMs);
    }
    return {
      count,
      allowed: limit <= 0 || count <= limit,
    };
  }

  private buildRedisKey(rule: string, key: string): string {
    const base = this.namespace ? `${this.namespace}:${rule}` : rule;
    return `${base}:${key}`;
  }
}

function parseScriptResponse(value: unknown): ScriptResult {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error("Unexpected Redis script response for quota enforcement");
  }
  const [countRaw, allowedRaw] = value;
  const count = Number(countRaw);
  const allowed = Number(allowedRaw) === 1;
  if (!Number.isFinite(count)) {
    throw new Error("Invalid counter value returned by Redis script");
  }
  return { count, allowed };
}

function validateRule(rule: AgentQuotaRuleConfig): void {
  if (!rule.name || typeof rule.name !== "string") {
    throw new Error("Quota rule requires a name");
  }
  if (!Number.isFinite(rule.limit) || rule.limit <= 0) {
    throw new Error(`Quota rule "${rule.name}" must specify a positive limit`);
  }
  if (!Number.isFinite(rule.intervalMs) || rule.intervalMs <= 0) {
    throw new Error(`Quota rule "${rule.name}" must specify a positive intervalMs`);
  }
  if (!rule.scope && !rule.key) {
    throw new Error(`Quota rule "${rule.name}" must provide a scope or key resolver`);
  }
}

function resolveKey(rule: AgentQuotaRuleConfig, context: AgentQuotaContext): string | undefined {
  if (rule.key) {
    return rule.key(context);
  }

  switch (rule.scope) {
    case "session": {
      const base = context.sessionId;
      if (!base) {
        return undefined;
      }
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

export { RATE_LIMIT_SCRIPT };

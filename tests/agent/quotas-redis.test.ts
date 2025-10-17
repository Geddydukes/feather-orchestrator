import { describe, expect, it, beforeEach } from "vitest";
import { RedisQuotaManager } from "../../src/agent/quotas-redis.js";
import { AgentError } from "../../src/agent/types.js";
import type { AgentQuotaConfig } from "../../src/agent/quotas.js";
import { MockRedisClient } from "../helpers/mock-redis.js";

const SESSION_ID = "quota-session";
const NAMESPACE = "quota";

describe("RedisQuotaManager", () => {
  let client: MockRedisClient;

  beforeEach(() => {
    client = new MockRedisClient();
  });

  it("enforces per-session limits", async () => {
    const config: AgentQuotaConfig = {
      rules: [
        { name: "session-window", limit: 2, intervalMs: 1000, scope: "session" },
      ],
    };
    const quota = new RedisQuotaManager(config, { client, namespace: NAMESPACE });

    await quota.consume({ sessionId: SESSION_ID });
    await quota.consume({ sessionId: SESSION_ID });
    await expect(quota.consume({ sessionId: SESSION_ID })).rejects.toThrow(AgentError);

    const redisKey = `${NAMESPACE}:session-window:${SESSION_ID}`;
    expect(client.getCounter(redisKey)).toBe(3);
  });

  it("resets counters after the interval expires", async () => {
    const config: AgentQuotaConfig = {
      rules: [
        { name: "session-window", limit: 1, intervalMs: 500, scope: "session" },
      ],
    };
    const quota = new RedisQuotaManager(config, { client, namespace: NAMESPACE });

    await quota.consume({ sessionId: SESSION_ID });
    await expect(quota.consume({ sessionId: SESSION_ID })).rejects.toThrow(AgentError);

    const redisKey = `${NAMESPACE}:session-window:${SESSION_ID}`;
    expect(client.getExpiry(redisKey)).toBeGreaterThan(0);

    client.advanceTime(500);
    await quota.consume({ sessionId: SESSION_ID });
  });

  it("builds keys using metadata for user scope", async () => {
    const config: AgentQuotaConfig = {
      rules: [
        {
          name: "user-window",
          limit: 1,
          intervalMs: 1000,
          scope: "user",
          metadataKey: "userId",
        },
      ],
    };
    const quota = new RedisQuotaManager(config, { client, namespace: NAMESPACE });

    await quota.consume({ sessionId: SESSION_ID, metadata: { userId: "user-1" } });
    await expect(
      quota.consume({ sessionId: SESSION_ID, metadata: { userId: "user-1" } })
    ).rejects.toThrow(AgentError);

    await quota.consume({ sessionId: SESSION_ID, metadata: { userId: "user-2" } });
  });

  it("optionally appends the tool name to keys", async () => {
    const config: AgentQuotaConfig = {
      rules: [
        {
          name: "tool-window",
          limit: 1,
          intervalMs: 1000,
          scope: "session",
          includeTool: true,
        },
      ],
    };
    const quota = new RedisQuotaManager(config, { client, namespace: NAMESPACE });

    await quota.consume({ sessionId: SESSION_ID, tool: "search" });
    await quota.consume({ sessionId: SESSION_ID, tool: "calc" });
    await expect(quota.consume({ sessionId: SESSION_ID, tool: "search" })).rejects.toThrow(
      AgentError
    );
  });
});

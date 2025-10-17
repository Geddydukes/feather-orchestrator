import { describe, expect, it } from "vitest";
import { InMemoryMemoryManager } from "../../src/memory/inmemory.js";
import { withAudit } from "../../src/memory/audit.js";
import type { MemoryAuditEvent } from "../../src/memory/audit.js";

const SESSION_ID = "session-audit";

describe("memory audit", () => {
  it("records append and trim actions", async () => {
    const base = new InMemoryMemoryManager();
    const events: MemoryAuditEvent[] = [];
    const manager = withAudit(base, {
      auditor: {
        record: (event) => {
          events.push(event);
        }
      }
    });

    await manager.append(SESSION_ID, { role: "user", content: "hello" });
    if (!manager.trim) {
      throw new Error("expected trim to be available");
    }
    await manager.trim(SESSION_ID, { retainTurns: 0 });

    expect(events.map((event) => event.action)).toEqual(["append", "trim"]);
    expect(events[0].turn?.content).toBe("hello");
    expect(events[1].options).toEqual({ retainTurns: 0 });
    expect(events.every((event) => event.timestamp instanceof Date)).toBe(true);
  });

  it("supports opt-in auditing for selected actions", async () => {
    const base = new InMemoryMemoryManager();
    const events: MemoryAuditEvent[] = [];
    const manager = withAudit(base, {
      auditor: {
        record: (event) => {
          events.push(event);
        }
      },
      actions: ["trim"]
    });

    await manager.append(SESSION_ID, { role: "user", content: "ignored" });
    if (!manager.trim) {
      throw new Error("expected trim to be available");
    }
    await manager.trim(SESSION_ID, { retainTurns: 1 });

    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("trim");
  });

  it("routes auditor failures to the provided handler", async () => {
    const base = new InMemoryMemoryManager();
    const errors: unknown[] = [];
    const events: MemoryAuditEvent[] = [];
    const manager = withAudit(base, {
      auditor: {
        record: () => {
          throw new Error("audit failed");
        }
      },
      onError: (error, event) => {
        errors.push(error);
        events.push(event);
      }
    });

    await manager.append(SESSION_ID, { role: "user", content: "test" });

    expect(errors).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("append");
  });
});

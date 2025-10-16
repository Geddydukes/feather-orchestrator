import { describe, expect, it } from "vitest";
import { InMemoryMemoryManager } from "../../src/memory/inmemory.js";
import { withRedaction, MemoryRedactionSwitch } from "../../src/memory/redaction.js";
import type { MemoryTurn } from "../../src/memory/types.js";

const SESSION_ID = "session-redaction";

function maskDigits<TTurn extends MemoryTurn>(turn: TTurn): TTurn {
  const content = typeof turn.content === "string" ? turn.content.replace(/\d/g, "*") : turn.content;
  return { ...turn, content } as TTurn;
}

describe("memory redaction", () => {
  it("redacts turns when enabled", async () => {
    const base = new InMemoryMemoryManager();
    const manager = withRedaction(base, {
      redactor: (turn) => maskDigits(turn)
    });

    await manager.append(SESSION_ID, { role: "user", content: "account 12345" });
    const [stored] = await base.getContext(SESSION_ID);

    expect(stored.content).toBe("account *****");
  });

  it("supports toggling redaction per session", async () => {
    const base = new InMemoryMemoryManager();
    const toggle = new MemoryRedactionSwitch(true);
    const manager = withRedaction(base, {
      redactor: (turn) => maskDigits(turn),
      toggle
    });

    await manager.append(SESSION_ID, { role: "user", content: "secret 111" });
    let [stored] = await base.getContext(SESSION_ID);
    expect(stored.content).toBe("secret ***");

    toggle.disable(SESSION_ID);
    await manager.append(SESSION_ID, { role: "user", content: "secret 222" });
    [stored] = await base.getContext(SESSION_ID);
    expect(stored.content).toBe("secret 222");

    toggle.enable(SESSION_ID);
    await manager.append(SESSION_ID, { role: "user", content: "secret 333" });
    [stored] = await base.getContext(SESSION_ID);
    expect(stored.content).toBe("secret ***");
  });

  it("respects include and exclude role filters", async () => {
    const base = new InMemoryMemoryManager();
    const manager = withRedaction(base, {
      redactor: (turn) => maskDigits(turn),
      includeRoles: ["user"],
      excludeRoles: ["assistant"]
    });

    await manager.append(SESSION_ID, { role: "system", content: "v1.0" });
    await manager.append(SESSION_ID, { role: "user", content: "code 999" });
    await manager.append(SESSION_ID, { role: "assistant", content: "reply 888" });

    const context = await base.getContext(SESSION_ID);
    expect(context.map((turn) => turn.content)).toEqual(["v1.0", "code ***", "reply 888"]);
  });
});

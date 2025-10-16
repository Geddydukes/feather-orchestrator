import type { MemoryManager, MemoryTrimOptions, MemoryTurn } from "./types.js";

export type MemoryAuditAction = "append" | "summarize" | "trim";

export interface MemoryAuditEvent<TTurn extends MemoryTurn = MemoryTurn> {
  action: MemoryAuditAction;
  sessionId: string;
  turn?: TTurn;
  options?: MemoryTrimOptions;
  timestamp: Date;
}

export interface MemoryAuditor<TTurn extends MemoryTurn = MemoryTurn> {
  record(event: MemoryAuditEvent<TTurn>): void | Promise<void>;
}

export interface MemoryAuditOptions<TTurn extends MemoryTurn = MemoryTurn> {
  auditor: MemoryAuditor<TTurn>;
  /** Limit auditing to the specified actions. Defaults to all actions. */
  actions?: readonly MemoryAuditAction[];
  /** Optional error handler invoked when the auditor throws. */
  onError?: (error: unknown, event: MemoryAuditEvent<TTurn>) => void;
}

export function withAudit<TTurn extends MemoryTurn>(
  base: MemoryManager<TTurn>,
  options: MemoryAuditOptions<TTurn>
): MemoryManager<TTurn> {
  if (!options || typeof options.auditor?.record !== "function") {
    throw new Error("Audit wrapper requires an auditor");
  }
  return new AuditedMemoryManager(base, options);
}

class AuditedMemoryManager<TTurn extends MemoryTurn> implements MemoryManager<TTurn> {
  private readonly actions: Set<MemoryAuditAction> | undefined;

  constructor(
    private readonly base: MemoryManager<TTurn>,
    private readonly options: MemoryAuditOptions<TTurn>
  ) {
    this.actions = options.actions ? new Set(options.actions) : undefined;
  }

  async append(sessionId: string, turn: TTurn): Promise<void> {
    await this.base.append(sessionId, turn);
    await this.record({ action: "append", sessionId, turn: cloneTurn(turn) });
  }

  async getContext(sessionId: string, options?: Parameters<MemoryManager<TTurn>["getContext"]>[1]): Promise<TTurn[]> {
    return this.base.getContext(sessionId, options);
  }

  async summarize(sessionId: string): Promise<void> {
    if (!this.base.summarize) {
      return;
    }
    await this.base.summarize(sessionId);
    await this.record({ action: "summarize", sessionId, timestamp: new Date() });
  }

  async trim(sessionId: string, options?: MemoryTrimOptions): Promise<void> {
    if (!this.base.trim) {
      return;
    }
    await this.base.trim(sessionId, options);
    await this.record({ action: "trim", sessionId, options: options ? { ...options } : undefined });
  }

  private async record(event: Omit<MemoryAuditEvent<TTurn>, "timestamp"> & { timestamp?: Date }): Promise<void> {
    if (this.actions && !this.actions.has(event.action)) {
      return;
    }

    const payload: MemoryAuditEvent<TTurn> = {
      action: event.action,
      sessionId: event.sessionId,
      turn: event.turn,
      options: event.options,
      timestamp: event.timestamp ?? new Date()
    };

    try {
      await this.options.auditor.record(payload);
    } catch (error) {
      if (this.options.onError) {
        this.options.onError(error, payload);
        return;
      }
      console.warn("Memory audit failed", error);
    }
  }
}

function cloneTurn<TTurn extends MemoryTurn>(turn: TTurn): TTurn {
  return {
    ...turn,
    createdAt: turn.createdAt ? new Date(turn.createdAt) : undefined,
  } as TTurn;
}

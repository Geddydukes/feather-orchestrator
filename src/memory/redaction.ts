import type { MemoryManager, MemoryTurn } from "./types.js";

export interface MemoryRedactionContext {
  sessionId: string;
}

export type MemoryRedactor<TTurn extends MemoryTurn = MemoryTurn> = (
  turn: TTurn,
  context: MemoryRedactionContext
) => TTurn | null | undefined;

export interface MemoryRedactionToggle {
  enable(sessionId: string): void;
  disable(sessionId: string): void;
  isEnabled(sessionId: string): boolean;
}

export interface MemoryRedactionOptions<TTurn extends MemoryTurn = MemoryTurn> {
  redactor: MemoryRedactor<TTurn>;
  /**
   * Toggle used to control whether redaction is applied per session. Defaults to a toggle that always
   * returns the {@link defaultEnabled} state.
   */
  toggle?: MemoryRedactionToggle;
  /** Whether redaction is enabled when a custom toggle is not provided. */
  defaultEnabled?: boolean;
  /** Optional allow-list of roles that should be redacted. */
  includeRoles?: readonly string[];
  /** Optional block-list of roles that should never be redacted. */
  excludeRoles?: readonly string[];
}

export class MemoryRedactionSwitch implements MemoryRedactionToggle {
  private readonly enabledSessions = new Set<string>();
  private readonly disabledSessions = new Set<string>();

  constructor(private readonly defaultEnabled: boolean = true) {}

  enable(sessionId: string): void {
    this.disabledSessions.delete(sessionId);
    this.enabledSessions.add(sessionId);
  }

  disable(sessionId: string): void {
    this.enabledSessions.delete(sessionId);
    this.disabledSessions.add(sessionId);
  }

  isEnabled(sessionId: string): boolean {
    if (this.enabledSessions.has(sessionId)) {
      return true;
    }
    if (this.disabledSessions.has(sessionId)) {
      return false;
    }
    return this.defaultEnabled;
  }
}

export function withRedaction<TTurn extends MemoryTurn>(
  base: MemoryManager<TTurn>,
  options: MemoryRedactionOptions<TTurn>
): MemoryManager<TTurn> {
  if (!options || typeof options.redactor !== "function") {
    throw new Error("Redaction requires a redactor function");
  }
  return new RedactingMemoryManager(base, options);
}

class RedactingMemoryManager<TTurn extends MemoryTurn> implements MemoryManager<TTurn> {
  private readonly toggle: MemoryRedactionToggle;
  private readonly includeRoles?: Set<string>;
  private readonly excludeRoles?: Set<string>;

  constructor(
    private readonly base: MemoryManager<TTurn>,
    private readonly options: MemoryRedactionOptions<TTurn>
  ) {
    const defaultEnabled = options.defaultEnabled ?? true;
    this.toggle = options.toggle ?? new MemoryRedactionSwitch(defaultEnabled);
    this.includeRoles = options.includeRoles ? new Set(options.includeRoles) : undefined;
    this.excludeRoles = options.excludeRoles ? new Set(options.excludeRoles) : undefined;
  }

  async append(sessionId: string, turn: TTurn): Promise<void> {
    if (!this.shouldRedact(sessionId, turn)) {
      await this.base.append(sessionId, turn);
      return;
    }

    const context: MemoryRedactionContext = { sessionId };
    const sanitized = this.options.redactor(cloneTurn(turn), context);
    if (!sanitized) {
      return;
    }

    await this.base.append(sessionId, ensureTurn(sanitized));
  }

  async getContext(sessionId: string, options?: Parameters<MemoryManager<TTurn>["getContext"]>[1]): Promise<TTurn[]> {
    return this.base.getContext(sessionId, options);
  }

  async summarize(sessionId: string): Promise<void> {
    if (!this.base.summarize) {
      return;
    }
    await this.base.summarize(sessionId);
  }

  async trim(sessionId: string, options?: Parameters<NonNullable<MemoryManager<TTurn>["trim"]>>[1]): Promise<void> {
    if (!this.base.trim) {
      return;
    }
    await this.base.trim(sessionId, options);
  }

  private shouldRedact(sessionId: string, turn: TTurn): boolean {
    const enabled = this.toggle.isEnabled(sessionId);
    if (!enabled) {
      return false;
    }

    const role = String(turn.role ?? "");
    if (this.excludeRoles && this.excludeRoles.has(role)) {
      return false;
    }
    if (this.includeRoles && !this.includeRoles.has(role)) {
      return false;
    }
    return true;
  }
}

function cloneTurn<TTurn extends MemoryTurn>(turn: TTurn): TTurn {
  return {
    ...turn,
    createdAt: turn.createdAt ? new Date(turn.createdAt) : undefined,
  } as TTurn;
}

function ensureTurn<TTurn extends MemoryTurn>(turn: TTurn): TTurn {
  if (!turn || typeof turn !== "object") {
    throw new Error("Redactor must return a MemoryTurn");
  }
  return turn;
}


import type { ChatProvider } from "./base.js";

export type Capability = "chat" | "stream" | "json" | "tools";

export interface ProviderEntry {
  key: string;                  // user key (e.g., "oai", "claude")
  inst: ChatProvider;
  models: Array<{
    name: string;               // provider native name
    aliases?: string[];         // unified names (e.g., "fast", "balanced", "gpt-4.1-mini")
    capabilities?: Capability[];
    inputPer1K?: number;
    outputPer1K?: number;
  }>;
}

export interface RegistryOpts {
  policy?: "cheapest" | "roundrobin" | "first";
}

export class ProviderRegistry {
  private list: ProviderEntry[] = [];
  private rr = 0;
  constructor(private opts?: RegistryOpts) {}

  add(entry: ProviderEntry) { this.list.push(entry); }

  get entries(): ProviderEntry[] { return this.list; }

  // Find all providers that match a given alias or model name
  private candidates(modelOrAlias?: string): Array<{ entry: ProviderEntry; model: string; inputPer1K?: number; outputPer1K?: number }> {
    const out: Array<{ entry: ProviderEntry; model: string; inputPer1K?: number; outputPer1K?: number }> = [];
    for (const e of this.list) {
      for (const m of e.models) {
        const match = !modelOrAlias
          || m.name === modelOrAlias
          || (m.aliases ?? []).includes(modelOrAlias);
        if (match) out.push({ entry: e, model: m.name, inputPer1K: m.inputPer1K, outputPer1K: m.outputPer1K });
      }
    }
    return out;
  }

  choose(modelOrAlias?: string) {
    const cands = this.candidates(modelOrAlias);
    if (cands.length === 0) throw new Error(`No provider registered for model '${modelOrAlias ?? "*"}'`);
    const policy = this.opts?.policy ?? "first";
    if (policy === "first") return cands[0];
    if (policy === "roundrobin") {
      const pick = cands[this.rr % cands.length];
      this.rr++;
      return pick;
    }
    // cheapest: sum input+output per 1k and pick min; fall back to first if missing
    let best = cands[0]; let bestCost = Number.POSITIVE_INFINITY;
    for (const c of cands) {
      const cost = (c.inputPer1K ?? 0) + (c.outputPer1K ?? 0);
      if (cost < bestCost) { best = c; bestCost = cost; }
    }
    return best;
  }
}

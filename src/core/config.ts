
import { ProviderRegistry } from "../providers/registry.js";
import { openai } from "../providers/openai.js";
import { anthropic } from "../providers/anthropic.js";

export interface FeatherConfig {
  policy?: "cheapest" | "roundrobin" | "first";
  providers?: {
    openai?: { apiKeyEnv?: string; baseUrl?: string; models?: Array<{ name: string; aliases?: string[]; inputPer1K?: number; outputPer1K?: number }> };
    anthropic?: { apiKeyEnv?: string; baseUrl?: string; models?: Array<{ name: string; aliases?: string[]; inputPer1K?: number; outputPer1K?: number }> };
  };
}

export function buildRegistry(cfg: FeatherConfig): ProviderRegistry {
  const reg = new ProviderRegistry({ policy: cfg.policy });
  if (cfg.providers?.openai) {
    const key = process.env[cfg.providers.openai.apiKeyEnv ?? "OPENAI_API_KEY"];
    if (key) {
      reg.add({
        key: "openai",
        inst: openai({ apiKey: key, baseUrl: cfg.providers.openai.baseUrl }),
        models: (cfg.providers.openai.models ?? []).map(m => ({ ...m }))
      });
    }
  }
  if (cfg.providers?.anthropic) {
    const key = process.env[cfg.providers.anthropic.apiKeyEnv ?? "ANTHROPIC_API_KEY"];
    if (key) {
      reg.add({
        key: "anthropic",
        inst: anthropic({ apiKey: key, baseUrl: cfg.providers.anthropic.baseUrl }),
        models: (cfg.providers.anthropic.models ?? []).map(m => ({ ...m }))
      });
    }
  }
  return reg;
}

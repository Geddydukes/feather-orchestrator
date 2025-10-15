
import { z } from "zod";
import { ProviderRegistry } from "../providers/registry.js";
import { openai } from "../providers/openai.js";
import { anthropic } from "../providers/anthropic.js";

const ModelSchema = z.object({
  name: z.string(),
  aliases: z.array(z.string()).optional(),
  inputPer1K: z.number().optional(),
  outputPer1K: z.number().optional(),
  capabilities: z.array(z.enum(["chat", "stream", "json", "tools"])).optional()
});

const ProviderSchema = z.object({
  apiKeyEnv: z.string().optional(),
  baseUrl: z.string().url().optional(),
  models: z.array(ModelSchema).optional()
});

const FeatherConfigSchema = z.object({
  policy: z.enum(["cheapest", "roundrobin", "first"]).optional(),
  providers: z.object({
    openai: ProviderSchema.optional(),
    anthropic: ProviderSchema.optional(),
  }).optional()
});

export type FeatherConfig = z.infer<typeof FeatherConfigSchema>;

export function buildRegistry(raw: unknown): ProviderRegistry {
  const cfg = FeatherConfigSchema.parse(raw);
  const reg = new ProviderRegistry({ policy: cfg.policy });

  const add = (key: "openai" | "anthropic", inst: any, models?: any[]) => {
    if (!inst) return;
    reg.add({
      key,
      inst,
      models: (models ?? []).map(m => ({ ...m }))
    });
  };

  const oaiK = process.env[cfg.providers?.openai?.apiKeyEnv ?? "OPENAI_API_KEY"];
  if (cfg.providers?.openai && oaiK) {
    add("openai", openai({ apiKey: oaiK, baseUrl: cfg.providers.openai.baseUrl }), cfg.providers.openai.models);
  }
  
  const claudeK = process.env[cfg.providers?.anthropic?.apiKeyEnv ?? "ANTHROPIC_API_KEY"];
  if (cfg.providers?.anthropic && claudeK) {
    add("anthropic", anthropic({ apiKey: claudeK, baseUrl: cfg.providers.anthropic.baseUrl }), cfg.providers.anthropic.models);
  }
  
  return reg;
}

import { createHash } from "node:crypto";
import type { ChatRequest } from "../types.js";

export const PROMPT_CACHE_KEY_VERSION = "v1";

export interface PromptKeyInput {
  provider: string;
  model: string;
  request: ChatRequest;
  extra?: Record<string, unknown>;
}

export function createPromptCacheKey(input: PromptKeyInput): string {
  if (!input || typeof input !== "object") {
    throw new Error("Prompt key input is required");
  }
  if (!input.provider) {
    throw new Error("Prompt key requires a provider identifier");
  }
  if (!input.model) {
    throw new Error("Prompt key requires a model identifier");
  }
  if (!input.request) {
    throw new Error("Prompt key requires a request payload");
  }

  const payload = {
    version: PROMPT_CACHE_KEY_VERSION,
    provider: input.provider,
    model: input.model,
    request: sanitizeRequest(input.request),
    extra: input.extra ?? null
  } as const;

  const serialised = stableStringify(payload);
  const hash = createHash("sha256").update(serialised).digest("hex");
  return `prompt:${PROMPT_CACHE_KEY_VERSION}:${hash}`;
}

function sanitizeRequest(request: ChatRequest): Record<string, unknown> {
  const normalised: Record<string, unknown> = {
    messages: request.messages?.map((message) => ({
      role: message.role,
      content: normalizeWhitespace(message.content)
    })) ?? []
  };

  if (request.temperature !== undefined) {
    normalised.temperature = request.temperature;
  }
  if (request.maxTokens !== undefined) {
    normalised.maxTokens = request.maxTokens;
  }
  if (request.topP !== undefined) {
    normalised.topP = request.topP;
  }

  return normalised;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items = value.map((entry) => stableStringify(entry));
    return `[${items.join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([keyA], [keyB]) => keyA.localeCompare(keyB));

  const content = entries
    .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`)
    .join(",");

  return `{${content}}`;
}

import type { ChatProvider } from "./base.js";
import type { ChatRequest, ChatResponse, ChatDelta, CallOpts } from "../types.js";
import { LLMError } from "../types.js";
import { USER_AGENT } from "../version.js";
import { createAbortError } from "../core/abort.js";

export interface OpenAIConfig { 
  apiKey: string; 
  baseUrl?: string;
  pricing?: { inputPer1K?: number; outputPer1K?: number };
}

export function openai(cfg: OpenAIConfig): ChatProvider {
  const base = cfg.baseUrl ?? "https://api.openai.com/v1";
  const pricing = cfg.pricing ?? { inputPer1K: 0.005, outputPer1K: 0.015 };
  
  return {
    id: "openai",
    async chat(req: ChatRequest, opts?: CallOpts): Promise<ChatResponse> {
      const response = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${cfg.apiKey}`,
          "user-agent": USER_AGENT,
        },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          temperature: req.temperature,
          max_tokens: req.maxTokens,
          top_p: req.topP,
        }),
        signal: opts?.signal
      });
      const requestId = response.headers?.get?.("x-request-id") ?? response.headers?.get?.("request-id") ?? undefined;
      if (!response.ok) {
        const message = await readErrorPayload(response);
        throw new LLMError(
          `OpenAI error ${response.status}: ${message}`,
          "openai",
          response.status,
          requestId,
          isRetryableStatus(response.status),
          parseRetryAfter(response)
        );
      }

      const json: any = await response.json();
      const choice = json.choices?.[0];
      const tokens = { input: json.usage?.prompt_tokens, output: json.usage?.completion_tokens };
      const price = priceForTokens(tokens.input, tokens.output, pricing);
      return { content: choice?.message?.content ?? "", raw: json, tokens, costUSD: price };
    },
    async *stream(req: ChatRequest, opts?: CallOpts): AsyncIterable<ChatDelta> {
      const response = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${cfg.apiKey}`,
          "user-agent": USER_AGENT,
        },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          stream: true,
        }),
        signal: opts?.signal
      });
      const requestId = response.headers?.get?.("x-request-id") ?? response.headers?.get?.("request-id") ?? undefined;
      if (!response.ok || !response.body) {
        const message = await readErrorPayload(response);
        throw new LLMError(
          `OpenAI stream error ${response.status}: ${message}`,
          "openai",
          response.status,
          requestId,
          isRetryableStatus(response.status),
          parseRetryAfter(response)
        );
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let aborted = false;

      const onAbort = () => {
        if (aborted) {
          return;
        }
        aborted = true;
        reader.cancel().catch(() => {});
      };

      if (opts?.signal) {
        if (opts.signal.aborted) {
          onAbort();
          throw createAbortError(opts.signal.reason);
        }
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          for (const line of chunk.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === "[DONE]") return;
            try {
              const json = JSON.parse(payload);
              const delta = json.choices?.[0]?.delta?.content;
              if (delta) yield { content: delta };
            } catch {}
          }
        }
      } finally {
        if (opts?.signal) {
          opts.signal.removeEventListener("abort", onAbort);
        }
        reader.releaseLock();
        if (aborted) {
          throw createAbortError(opts?.signal?.reason);
        }
      }
    },
    price: pricing,
  };
}

function priceForTokens(input?: number, output?: number, pricing?: { inputPer1K?: number; outputPer1K?: number }) {
  const inputPer1K = pricing?.inputPer1K ?? 0.005;
  const outputPer1K = pricing?.outputPer1K ?? 0.015;
  const inUSD = (input ?? 0) / 1000 * inputPer1K;
  const outUSD = (output ?? 0) / 1000 * outputPer1K;
  return +(inUSD + outUSD).toFixed(6);
}

async function readErrorPayload(response: Response): Promise<string> {
  try {
    const source: Partial<Response> = typeof response.clone === "function" ? response.clone() : response;
    if (typeof source.json === "function") {
      const json = await source.json();
      const message = (json as any)?.error?.message ?? (json as any)?.message;
      if (typeof message === "string" && message.length > 0) {
        return message;
      }
      return JSON.stringify(json);
    }
  } catch {
    try {
      if (typeof response.text === "function") {
        return await response.text();
      }
    } catch {
      return "Unknown error";
    }
  }
  return "Unknown error";
}

function parseRetryAfter(response: Response): number | undefined {
  const header = response.headers?.get?.("retry-after");
  if (!header) {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return seconds;
  }
  const date = new Date(header);
  if (!Number.isNaN(date.getTime())) {
    const delta = (date.getTime() - Date.now()) / 1000;
    return delta > 0 ? delta : undefined;
  }
  return undefined;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

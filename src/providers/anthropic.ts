
import type { ChatProvider } from "./base.js";
import type { ChatRequest, ChatResponse, ChatDelta } from "../types.js";

export interface AnthropicConfig { 
  apiKey: string; 
  baseUrl?: string;
  pricing?: { inputPer1K?: number; outputPer1K?: number };
}

type AnthropicMsg = { role: "user" | "assistant"; content: string };

function mapMessages(msgs: ChatRequest["messages"]): AnthropicMsg[] {
  // Convert system to a prefixed user instruction, keep user/assistant as-is
  const out: AnthropicMsg[] = [];
  let systemPrefix = "";
  for (const m of msgs) {
    if (m.role === "system") {
      systemPrefix += (systemPrefix ? "\n" : "") + m.content;
    } else if (m.role === "user") {
      out.push({ role: "user", content: (systemPrefix ? systemPrefix + "\n" : "") + m.content });
      systemPrefix = "";
    } else if (m.role === "assistant") {
      out.push({ role: "assistant", content: m.content });
    }
  }
  return out;
}

export function anthropic(cfg: AnthropicConfig): ChatProvider {
  const base = cfg.baseUrl ?? "https://api.anthropic.com/v1";
  const pricing = cfg.pricing ?? { inputPer1K: 0.008, outputPer1K: 0.024 };
  
  return {
    id: "anthropic",
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const messages = mapMessages(req.messages);
      const r = await fetch(`${base}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": cfg.apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens ?? 1024,
          temperature: req.temperature,
          messages
        }),
      });
      if (!r.ok) throw new Error(`Anthropic ${r.status}`);
      const json: any = await r.json();
      const content = (json.content?.[0]?.text) ?? "";
      const tokens = { input: json.usage?.input_tokens, output: json.usage?.output_tokens };
      const price = priceForTokens(tokens.input, tokens.output, pricing);
      return { content, raw: json, tokens, costUSD: price };
    },
    async *stream(req: ChatRequest): AsyncIterable<ChatDelta> {
      const messages = mapMessages(req.messages);
      const r = await fetch(`${base}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": cfg.apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens ?? 1024,
          temperature: req.temperature,
          messages,
          stream: true
        }),
      });
      if (!r.ok || !r.body) throw new Error(`Anthropic stream ${r.status}`);
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
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
            const delta = json.delta?.text ?? json.content_block?.text ?? "";
            if (delta) yield { content: delta };
          } catch {}
        }
      }
    },
    price: pricing,
  };
}

function priceForTokens(input?: number, output?: number, pricing?: { inputPer1K?: number; outputPer1K?: number }) {
  const inputPer1K = pricing?.inputPer1K ?? 0.008;
  const outputPer1K = pricing?.outputPer1K ?? 0.024;
  const inUSD = (input ?? 0) / 1000 * inputPer1K;
  const outUSD = (output ?? 0) / 1000 * outputPer1K;
  return +(inUSD + outUSD).toFixed(6);
}

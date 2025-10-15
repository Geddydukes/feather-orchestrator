import type { ChatProvider } from "./base.js";
import type { ChatRequest, ChatResponse, ChatDelta } from "../types.js";

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
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          temperature: req.temperature,
          max_tokens: req.maxTokens,
          top_p: req.topP,
        }),
      });
      if (!r.ok) throw new Error(`OpenAI ${r.status}`);
      const json: any = await r.json();
      const choice = json.choices?.[0];
      const tokens = { input: json.usage?.prompt_tokens, output: json.usage?.completion_tokens };
      const price = priceForTokens(tokens.input, tokens.output, pricing);
      return { content: choice?.message?.content ?? "", raw: json, tokens, costUSD: price };
    },
    async *stream(req: ChatRequest): AsyncIterable<ChatDelta> {
      const r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          stream: true,
        }),
      });
      if (!r.ok || !r.body) throw new Error(`OpenAI stream ${r.status}`);
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
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) yield { content: delta };
          } catch {}
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

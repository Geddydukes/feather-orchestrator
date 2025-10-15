
import type { ChatDelta } from "../types.js";

export async function* sseToDeltas(resp: Response, pick: (json: any) => string | undefined): AsyncIterable<ChatDelta> {
  if (!resp.ok || !resp.body) throw new Error(`stream error ${resp.status}`);
  const reader = resp.body.getReader();
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
        const content = pick(json);
        if (content) yield { content };
      } catch {}
    }
  }
}

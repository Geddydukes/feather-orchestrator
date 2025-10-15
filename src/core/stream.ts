
import type { ChatDelta } from "../types.js";

export async function* sseToDeltas(
  resp: Response,
  pick: (json: any) => string | undefined
): AsyncIterable<ChatDelta> {
  if (!resp.ok || !resp.body) throw new Error(`stream error ${resp.status}`);
  
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    
    buf += dec.decode(value, { stream: true });
    let nl;
    
    while ((nl = buf.search(/\r?\n/)) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + (buf[nl] === "\r" && buf[nl+1] === "\n" ? 2 : 1));
      const t = line.trim();
      
      if (!t || t.startsWith(":")) continue; // heartbeat
      if (!t.startsWith("data:")) continue;
      
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") return;
      
      try {
        const json = JSON.parse(payload);
        const c = pick(json);
        if (c) yield { content: c };
      } catch {
        // Ignore malformed JSON
      }
    }
  }
}

export async function* ndjsonToDeltas(
  resp: Response,
  pick: (json: any) => string | undefined
): AsyncIterable<ChatDelta> {
  if (!resp.ok || !resp.body) throw new Error(`stream error ${resp.status}`);
  
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    
    buf += dec.decode(value, { stream: true });
    let nl;
    
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      
      if (!line) continue;
      
      try {
        const json = JSON.parse(line);
        const c = pick(json);
        if (c) yield { content: c };
      } catch {
        // Ignore malformed JSON
      }
    }
  }
}

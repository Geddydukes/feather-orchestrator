
import { Feather } from "../src/core/Orchestrator.js";
import { openai } from "../src/providers/openai.js";

(async () => {
  const f = new Feather({ providers: { oai: openai({ apiKey: process.env.OPENAI_API_KEY! }) } });
  const res = await f.chat({
    provider: "oai",
    model: "gpt-4.1-mini",
    messages: [{ role: "user", content: "Hello, who are you?" }]
  });
  console.log(res.content);
})();

#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Feather } from "../core/Orchestrator.js";
import { buildRegistry, type FeatherConfig } from "../core/config.js";

function parseArgs(argv: string[]) {
  const o: any = { model: "", query: "", config: "feather.config.json" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-p" || a === "--provider") o.provider = argv[++i]; // optional
    else if (a === "-m" || a === "--model") o.model = argv[++i];
    else if (a === "-q" || a === "--query") o.query = argv[++i];
    else if (a === "-c" || a === "--config") o.config = argv[++i];
    else if (a === "-h" || a === "--help") o.help = true;
  }
  return o;
}

function loadConfig(startDir: string, filename: string): FeatherConfig | null {
  let dir = startDir;
  while (true) {
    const fp = path.join(dir, filename);
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, "utf-8"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.model || !args.query) {
    console.log(`Usage:
  feather chat [-p <provider>] -m <model-or-alias> -q <prompt> [-c <config>]

If provider is omitted, the orchestrator selects one via policy and alias mapping.
Env: OPENAI_API_KEY, ANTHROPIC_API_KEY (or use config apiKeyEnv).
`);
    process.exit(args.help ? 0 : 1);
  }

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const cfg = loadConfig(process.cwd(), args.config) ?? loadConfig(__dirname, args.config) ?? { policy: "first" };
  const registry = buildRegistry(cfg);

  const f = new Feather({ registry });
  const res = await f.chat({
    provider: args.provider, // optional
    model: args.model,
    messages: [{ role: "user", content: args.query }]
  });
  console.log(res.content);
}

main().catch(e => {
  console.error(e?.message ?? e);
  process.exit(3);
});
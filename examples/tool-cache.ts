#!/usr/bin/env node

import {
  Agent,
  InMemoryMemoryManager,
  ToolCache,
  createCalcTool,
  withToolCache,
  type AgentPlan,
  type AgentMemoryTurn,
  type MemoryGetContextOptions,
  type MemoryManager,
  type PlannerContext,
} from "../src/index.js";

const toolCache = new ToolCache({ ttlSeconds: 120 });
const cachedCalc = withToolCache(createCalcTool(), { cache: toolCache });

const planner = async ({ input }: PlannerContext): Promise<AgentPlan> => ({
  actions: [
    {
      tool: "calc",
      input: { expression: input.content },
    },
  ],
});

const baseMemory = new InMemoryMemoryManager();

const memory: MemoryManager<AgentMemoryTurn> = {
  append: (sessionId, turn) => baseMemory.append(sessionId, turn),
  getContext: async (sessionId, options?: MemoryGetContextOptions) => {
    const turns = await baseMemory.getContext(sessionId, options);
    return turns.map((turn) => ({
      ...turn,
      content: turn.content as AgentMemoryTurn["content"],
    }));
  },
  summarize: baseMemory.summarize?.bind(baseMemory),
  trim: baseMemory.trim?.bind(baseMemory),
};

const agent = new Agent({
  id: "tool-cache-demo",
  planner,
  memory,
  tools: [cachedCalc],
  toolCache,
  onEvent(event) {
    if (event.type === "agent.tool.end") {
      console.log(
        `Tool result (cacheHit=${event.cached}):`,
        event.result,
      );
    }
  },
});

const sessionId = "cache-demo";

for (let run = 1; run <= 2; run += 1) {
  const result = await agent.run({
    sessionId,
    input: { role: "user", content: "(10 + 32) / 2" },
  });
  if (result.status === "completed") {
    console.log(`Run ${run} final:`, result.output.content);
  } else {
    console.log(`Run ${run} error:`, result.error.message);
  }
}

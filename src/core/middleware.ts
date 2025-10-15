
import type { Middleware } from "../types.js";

export async function runMiddleware<T>(stack: Middleware[], i: number, ctx: any, terminal: () => Promise<T>): Promise<T> {
  if (i >= stack.length) return terminal();
  const layer = stack[i];
  return layer(ctx, async () => {
    await runMiddleware(stack, i + 1, ctx, terminal);
  }) as Promise<T>;
}

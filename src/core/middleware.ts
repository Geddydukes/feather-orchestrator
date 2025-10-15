
import type { Middleware } from "../types.js";

export async function runMiddleware<T>(
  stack: Middleware[],
  i: number,
  ctx: any,
  terminal: () => Promise<T>
): Promise<T> {
  if (i >= stack.length) return terminal();
  
  const layer = stack[i];
  let error: unknown;
  let done = false;
  
  try {
    await layer(ctx, async () => {
      return await runMiddleware(stack, i + 1, ctx, terminal);
    });
    done = true;
    return terminal();
  } catch (e) {
    error = e;
    throw e;
  } finally {
    // Give middleware a chance to perform after-hooks if they wrapped next()
    if (!done && typeof (layer as any).finally === "function") {
      try {
        await (layer as any).finally(ctx, error);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

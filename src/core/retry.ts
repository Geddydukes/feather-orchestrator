
import type { RetryOpts } from "../types.js";

const defaultStatusRetry = (s: number) =>
  s === 408 || s === 429 || (s >= 500 && s <= 599);

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOpts = {}
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const base = opts.baseMs ?? 250;
  const cap = opts.maxMs ?? 3000;
  const jitter = opts.jitter ?? "full";
  const retryPolicy = opts.statusRetry ?? defaultStatusRetry;
  const start = Date.now();

  let attempt = 0;
  while (true) {
    if (opts.signal?.aborted) throw createAbortError();
    
    try {
      return await fn();
    } catch (e: any) {
      attempt++;
      if (attempt >= maxAttempts) throw e;

      // If error exposes HTTP status, classify
      const status = e?.status ?? e?.info?.status;
      if (typeof status === "number" && !retryPolicy(status)) throw e;

      // Respect Retry-After header if present
      let wait = Math.min(cap, base * 2 ** (attempt - 1));
      const ra = e?.retryAfter ?? e?.info?.retryAfter;
      let waitMs: number;
      if (typeof ra === "number") {
        wait = Math.max(wait, ra * 1000);
        waitMs = wait; // honor Retry-After without jitter
      } else {
        waitMs = jitter === "full" ? wait * (0.5 + Math.random()) : wait;
      }
      if (opts.maxTotalMs && Date.now() + waitMs - start > opts.maxTotalMs) throw e;

      opts.onRetry?.({ attempt, waitMs, error: e });
      await delay(waitMs, opts.signal);
    }
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(resolve, ms);
    
    if (signal) {
      const onAbort = () => {
        clearTimeout(timeoutId);
        reject(createAbortError());
      };
      
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });
}

function createAbortError(): Error {
  return Object.assign(new Error("Aborted"), { name: "AbortError" });
}


export async function withRetry<T>(fn: () => Promise<T>, opts?: { maxAttempts?: number; baseMs?: number; maxMs?: number; jitter?: "none" | "full" }) {
  const maxAttempts = opts?.maxAttempts ?? 3;
  const base = opts?.baseMs ?? 250;
  const cap = opts?.maxMs ?? 3000;
  const jitter = opts?.jitter ?? "full";
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (e) {
      attempt++;
      if (attempt >= maxAttempts) throw e;
      const exp = Math.min(cap, base * 2 ** (attempt - 1));
      const wait = jitter === "full" ? exp * (0.5 + Math.random()) : exp;
      await new Promise(res => setTimeout(res, wait));
    }
  }
}

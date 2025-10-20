export function createAbortError(reason?: unknown): Error {
  if (reason instanceof DOMException && reason.name === "AbortError") {
    return reason;
  }

  if (reason instanceof Error) {
    const abort = new DOMException(reason.message || "Aborted", "AbortError");
    try {
      (abort as any).cause = reason;
    } catch {
      // Ignore if cause is read-only.
    }
    return abort;
  }

  return new DOMException("Aborted", "AbortError");
}

export function forwardAbortSignal(
  source: AbortSignal | undefined,
  target: AbortController
): () => void {
  if (!source) {
    return () => {};
  }

  if (source.aborted) {
    target.abort(source.reason);
    return () => {};
  }

  const abortListener = () => {
    if (!target.signal.aborted) {
      target.abort(source.reason);
    }
  };

  source.addEventListener("abort", abortListener, { once: true });
  return () => {
    source.removeEventListener("abort", abortListener);
  };
}

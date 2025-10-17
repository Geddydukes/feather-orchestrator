export function createAbortError(reason?: unknown): Error {
  if (reason instanceof DOMException && reason.name === "AbortError") {
    return reason;
  }

  if (reason instanceof Error) {
    return new DOMException(reason.message || "Aborted", "AbortError");
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

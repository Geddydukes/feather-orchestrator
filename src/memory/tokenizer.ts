export interface TokenCounter {
  /**
   * Estimate the token count of a piece of content. Implementations should be deterministic so
   * callers can enforce hard budgets across runs.
   */
  count(content: unknown): number;
}

function countTextTokens(text: string): number {
  const normalized = text.trim();
  if (normalized.length === 0) {
    return 0;
  }

  // Split on whitespace boundaries while keeping punctuation attached to words. This keeps the
  // counter fast but still sensitive to long strings.
  const tokens = normalized.split(/\s+/u).filter(Boolean);
  return tokens.length;
}

/**
 * Basic deterministic tokenizer that works without any native dependencies. The heuristic treats
 * whitespace separated terms as tokens and stringifies objects to include their structural cost.
 */
export class BasicTokenCounter implements TokenCounter {
  count(content: unknown): number {
    if (content == null) {
      return 0;
    }

    if (typeof content === "string") {
      return countTextTokens(content);
    }

    if (typeof content === "number" || typeof content === "boolean") {
      return countTextTokens(String(content));
    }

    if (Array.isArray(content)) {
      return content.reduce((total, item) => total + this.count(item), 0);
    }

    if (typeof content === "object") {
      try {
        return countTextTokens(JSON.stringify(content));
      } catch (error) {
        // Fallback to a generic string representation if JSON serialization fails.
        return countTextTokens(String(content));
      }
    }

    return countTextTokens(String(content));
  }
}

export const defaultTokenCounter = new BasicTokenCounter();

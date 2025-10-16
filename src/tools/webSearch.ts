import type { Tool, ToolRunContext } from "./types.js";

export interface WebSearchArgs {
  query: string;
  topK?: number;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
  publishedAt?: string;
  source?: string;
}

export interface WebSearchAdapter {
  search(request: {
    query: string;
    topK: number;
    signal?: AbortSignal;
    metadata?: Record<string, unknown>;
  }): Promise<WebSearchResult[]>;
}

export interface CreateWebSearchToolOptions {
  name?: string;
  description?: string;
  defaultTopK?: number;
  maxTopK?: number;
  minQueryLength?: number;
  maxQueryLength?: number;
  cacheTtlSec?: number;
}

const DEFAULT_NAME = "web.search";
const DEFAULT_DESCRIPTION = "Search the web for up-to-date information.";
const DEFAULT_TOP_K = 5;
const DEFAULT_MAX_TOP_K = 10;
const DEFAULT_MIN_QUERY_LENGTH = 3;
const DEFAULT_MAX_QUERY_LENGTH = 256;

export function createWebSearchTool(
  adapter: WebSearchAdapter,
  options: CreateWebSearchToolOptions = {}
): Tool<WebSearchArgs, WebSearchResult[]> {
  if (!adapter || typeof adapter.search !== "function") {
    throw new Error("createWebSearchTool requires an adapter with a search method");
  }

  const name = options.name?.trim() || DEFAULT_NAME;
  const description = options.description?.trim() || DEFAULT_DESCRIPTION;
  const defaultTopK = options.defaultTopK ?? DEFAULT_TOP_K;
  const maxTopK = options.maxTopK ?? DEFAULT_MAX_TOP_K;
  const minQueryLength = options.minQueryLength ?? DEFAULT_MIN_QUERY_LENGTH;
  const maxQueryLength = options.maxQueryLength ?? DEFAULT_MAX_QUERY_LENGTH;

  if (defaultTopK <= 0 || !Number.isInteger(defaultTopK)) {
    throw new Error("defaultTopK must be a positive integer");
  }
  if (maxTopK <= 0 || !Number.isInteger(maxTopK)) {
    throw new Error("maxTopK must be a positive integer");
  }
  if (defaultTopK > maxTopK) {
    throw new Error("defaultTopK cannot be greater than maxTopK");
  }
  if (minQueryLength <= 0 || maxQueryLength <= 0 || minQueryLength > maxQueryLength) {
    throw new Error("Invalid query length bounds");
  }

  return {
    name,
    description,
    cacheTtlSec: options.cacheTtlSec,
    async run(args: WebSearchArgs, ctx: ToolRunContext): Promise<WebSearchResult[]> {
      if (!args || typeof args.query !== "string") {
        throw new Error("web.search tool requires a query string");
      }
      const query = args.query.trim();
      if (query.length < minQueryLength) {
        throw new Error(`Query must be at least ${minQueryLength} characters`);
      }
      if (query.length > maxQueryLength) {
        throw new Error(`Query exceeds maximum length of ${maxQueryLength} characters`);
      }

      const requestedTopK = args.topK ?? defaultTopK;
      if (!Number.isInteger(requestedTopK) || requestedTopK <= 0) {
        throw new Error("topK must be a positive integer when provided");
      }
      const topK = Math.min(requestedTopK, maxTopK);

      const results = await adapter.search({
        query,
        topK,
        signal: ctx.signal,
        metadata: ctx.metadata,
      });

      if (!Array.isArray(results)) {
        throw new Error("Web search adapter must return an array of results");
      }

      const normalised = results.slice(0, topK).map(normalizeResult);
      return normalised;
    },
  } satisfies Tool<WebSearchArgs, WebSearchResult[]>;
}

function normalizeResult(result: WebSearchResult): WebSearchResult {
  if (!result || typeof result !== "object") {
    throw new Error("Web search result must be an object");
  }
  const { title, url, snippet, score, publishedAt, source } = result;
  if (typeof title !== "string" || title.trim() === "") {
    throw new Error("Web search result is missing a title");
  }
  if (typeof url !== "string" || url.trim() === "") {
    throw new Error("Web search result is missing a URL");
  }
  if (typeof snippet !== "string") {
    throw new Error("Web search result is missing a snippet");
  }
  if (score !== undefined && typeof score !== "number") {
    throw new Error("Web search result score must be numeric when provided");
  }
  if (publishedAt !== undefined && typeof publishedAt !== "string") {
    throw new Error("publishedAt must be a string when provided");
  }
  if (source !== undefined && typeof source !== "string") {
    throw new Error("source must be a string when provided");
  }
  return {
    title: title.trim(),
    url: url.trim(),
    snippet: snippet.trim(),
    score,
    publishedAt,
    source,
  } satisfies WebSearchResult;
}

import type { ChatRequest, ChatResponse, ChatDelta, CallOpts, TokenEstimate, PriceTable } from "../types.js";

export interface ChatProvider {
  id: string;
  chat(req: ChatRequest, opts?: CallOpts): Promise<ChatResponse>;
  stream?(req: ChatRequest, opts?: CallOpts): AsyncIterable<ChatDelta>;
  estimate?(req: ChatRequest): TokenEstimate;
  price?: PriceTable;
}

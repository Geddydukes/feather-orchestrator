import { describe, it, expect } from "vitest";
import { sseToDeltas, ndjsonToDeltas } from "../src/core/stream.js";

const encoder = new TextEncoder();

function makeStreamResponse(...chunks: string[]) {
  let index = 0;
  return {
    ok: true,
    body: {
      getReader: () => ({
        async read() {
          if (index < chunks.length) {
            const value = encoder.encode(chunks[index++]);
            return { value, done: false };
          }
          return { value: undefined, done: true };
        }
      })
    }
  } as any;
}

describe("Stream Parsers", () => {
  describe("sseToDeltas", () => {
    it("should parse basic SSE data", async () => {
      const mockResponse = makeStreamResponse('data: {"content": "hello"}\n\n');

      const pick = (json: any) => json.content;
      const results: any[] = [];

      for await (const delta of sseToDeltas(mockResponse, pick)) {
        results.push(delta);
      }
      
      expect(results).toEqual([{ content: "hello" }]);
    });

    it("should handle CRLF line endings", async () => {
      const mockResponse = makeStreamResponse('data: {"content": "hello"}\r\n\r\n');

      const pick = (json: any) => json.content;
      const results: any[] = [];

      for await (const delta of sseToDeltas(mockResponse, pick)) {
        results.push(delta);
      }
      
      expect(results).toEqual([{ content: "hello" }]);
    });

    it("should ignore heartbeat lines", async () => {
      const mockResponse = makeStreamResponse(': heartbeat\ndata: {"content": "hello"}\n\n');

      const pick = (json: any) => json.content;
      const results: any[] = [];

      for await (const delta of sseToDeltas(mockResponse, pick)) {
        results.push(delta);
      }
      
      expect(results).toEqual([{ content: "hello" }]);
    });

    it("should handle [DONE] signal", async () => {
      const mockResponse = makeStreamResponse('data: [DONE]\n\n');

      const pick = (json: any) => json.content;
      const results: any[] = [];

      for await (const delta of sseToDeltas(mockResponse, pick)) {
        results.push(delta);
      }
      
      expect(results).toEqual([]);
    });

    it("should handle malformed JSON gracefully", async () => {
      const mockResponse = makeStreamResponse('data: invalid json\ndata: {"content": "hello"}\n\n');

      const pick = (json: any) => json.content;
      const results: any[] = [];

      for await (const delta of sseToDeltas(mockResponse, pick)) {
        results.push(delta);
      }
      
      expect(results).toEqual([{ content: "hello" }]);
    });

    it("should handle partial frames", async () => {
      const mockResponse = makeStreamResponse('data: {"content": "hel');

      const pick = (json: any) => json.content;
      const results: any[] = [];

      for await (const delta of sseToDeltas(mockResponse, pick)) {
        results.push(delta);
      }
      
      expect(results).toEqual([]);
    });
  });

  describe("ndjsonToDeltas", () => {
    it("should parse NDJSON data", async () => {
      const mockResponse = makeStreamResponse('{"content": "hello"}\n{"content": "world"}\n');

      const pick = (json: any) => json.content;
      const results: any[] = [];

      for await (const delta of ndjsonToDeltas(mockResponse, pick)) {
        results.push(delta);
      }
      
      expect(results).toEqual([{ content: "hello" }, { content: "world" }]);
    });

    it("should ignore empty lines", async () => {
      const mockResponse = makeStreamResponse('\n{"content": "hello"}\n\n');

      const pick = (json: any) => json.content;
      const results: any[] = [];

      for await (const delta of ndjsonToDeltas(mockResponse, pick)) {
        results.push(delta);
      }
      
      expect(results).toEqual([{ content: "hello" }]);
    });

    it("should handle malformed JSON gracefully", async () => {
      const mockResponse = makeStreamResponse('invalid json\n{"content": "hello"}\n');

      const pick = (json: any) => json.content;
      const results: any[] = [];

      for await (const delta of ndjsonToDeltas(mockResponse, pick)) {
        results.push(delta);
      }
      
      expect(results).toEqual([{ content: "hello" }]);
    });

    it("should handle partial lines", async () => {
      const mockResponse = makeStreamResponse('{"content": "hel');

      const pick = (json: any) => json.content;
      const results: any[] = [];

      for await (const delta of ndjsonToDeltas(mockResponse, pick)) {
        results.push(delta);
      }
      
      expect(results).toEqual([]);
    });
  });
});

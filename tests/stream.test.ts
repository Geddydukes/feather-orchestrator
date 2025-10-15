import { describe, it, expect } from "vitest";
import { sseToDeltas, ndjsonToDeltas } from "../src/core/stream.js";

describe("Stream Parsers", () => {
  describe("sseToDeltas", () => {
    it("should parse basic SSE data", async () => {
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => ({
            read: async () => ({
              value: new TextEncoder().encode('data: {"content": "hello"}\n\n'),
              done: false
            })
          })
        }
      } as any;

      const pick = (json: any) => json.content;
      const results: any[] = [];
      
      for await (const delta of sseToDeltas(mockResponse, pick)) {
        results.push(delta);
      }
      
      expect(results).toEqual([{ content: "hello" }]);
    });

    it("should handle CRLF line endings", async () => {
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => ({
            read: async () => ({
              value: new TextEncoder().encode('data: {"content": "hello"}\r\n\r\n'),
              done: false
            })
          })
        }
      } as any;

      const pick = (json: any) => json.content;
      const results: any[] = [];
      
      for await (const delta of sseToDeltas(mockResponse, pick)) {
        results.push(delta);
      }
      
      expect(results).toEqual([{ content: "hello" }]);
    });

    it("should ignore heartbeat lines", async () => {
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => ({
            read: async () => ({
              value: new TextEncoder().encode(': heartbeat\ndata: {"content": "hello"}\n\n'),
              done: false
            })
          })
        }
      } as any;

      const pick = (json: any) => json.content;
      const results: any[] = [];
      
      for await (const delta of sseToDeltas(mockResponse, pick)) {
        results.push(delta);
      }
      
      expect(results).toEqual([{ content: "hello" }]);
    });

    it("should handle [DONE] signal", async () => {
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => ({
            read: async () => ({
              value: new TextEncoder().encode('data: [DONE]\n\n'),
              done: false
            })
          })
        }
      } as any;

      const pick = (json: any) => json.content;
      const results: any[] = [];
      
      for await (const delta of sseToDeltas(mockResponse, pick)) {
        results.push(delta);
      }
      
      expect(results).toEqual([]);
    });

    it("should handle malformed JSON gracefully", async () => {
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => ({
            read: async () => ({
              value: new TextEncoder().encode('data: invalid json\ndata: {"content": "hello"}\n\n'),
              done: false
            })
          })
        }
      } as any;

      const pick = (json: any) => json.content;
      const results: any[] = [];
      
      for await (const delta of sseToDeltas(mockResponse, pick)) {
        results.push(delta);
      }
      
      expect(results).toEqual([{ content: "hello" }]);
    });

    it("should handle partial frames", async () => {
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => ({
            read: async () => ({
              value: new TextEncoder().encode('data: {"content": "hel'),
              done: false
            })
          })
        }
      } as any;

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
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => ({
            read: async () => ({
              value: new TextEncoder().encode('{"content": "hello"}\n{"content": "world"}\n'),
              done: false
            })
          })
        }
      } as any;

      const pick = (json: any) => json.content;
      const results: any[] = [];
      
      for await (const delta of ndjsonToDeltas(mockResponse, pick)) {
        results.push(delta);
      }
      
      expect(results).toEqual([{ content: "hello" }, { content: "world" }]);
    });

    it("should ignore empty lines", async () => {
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => ({
            read: async () => ({
              value: new TextEncoder().encode('\n{"content": "hello"}\n\n'),
              done: false
            })
          })
        }
      } as any;

      const pick = (json: any) => json.content;
      const results: any[] = [];
      
      for await (const delta of ndjsonToDeltas(mockResponse, pick)) {
        results.push(delta);
      }
      
      expect(results).toEqual([{ content: "hello" }]);
    });

    it("should handle malformed JSON gracefully", async () => {
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => ({
            read: async () => ({
              value: new TextEncoder().encode('invalid json\n{"content": "hello"}\n'),
              done: false
            })
          })
        }
      } as any;

      const pick = (json: any) => json.content;
      const results: any[] = [];
      
      for await (const delta of ndjsonToDeltas(mockResponse, pick)) {
        results.push(delta);
      }
      
      expect(results).toEqual([{ content: "hello" }]);
    });

    it("should handle partial lines", async () => {
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => ({
            read: async () => ({
              value: new TextEncoder().encode('{"content": "hel'),
              done: false
            })
          })
        }
      } as any;

      const pick = (json: any) => json.content;
      const results: any[] = [];
      
      for await (const delta of ndjsonToDeltas(mockResponse, pick)) {
        results.push(delta);
      }
      
      expect(results).toEqual([]);
    });
  });
});

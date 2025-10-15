import { describe, it, expect, vi } from "vitest";
import { runMiddleware } from "../src/core/middleware.js";
import type { Middleware } from "../src/types.js";

describe("runMiddleware", () => {
  it("should run middleware in order", async () => {
    const order: number[] = [];
    const middleware: Middleware[] = [
      async (ctx, next) => {
        order.push(1);
        await next();
        order.push(4);
      },
      async (ctx, next) => {
        order.push(2);
        await next();
        order.push(3);
      }
    ];

    const terminal = async () => "result";
    const result = await runMiddleware(middleware, 0, {}, terminal);
    
    expect(result).toBe("result");
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("should handle middleware without next", async () => {
    const middleware: Middleware[] = [
      async (ctx, next) => {
        // Middleware should not return values, just call next or not
        await next();
      }
    ];

    const terminal = async () => "terminal";
    const result = await runMiddleware(middleware, 0, {}, terminal);
    
    expect(result).toBe("terminal");
  });

  it("should propagate errors", async () => {
    const middleware: Middleware[] = [
      async (ctx, next) => {
        await next();
      },
      async (ctx, next) => {
        throw new Error("middleware error");
      }
    ];

    const terminal = async () => "terminal";
    
    await expect(runMiddleware(middleware, 0, {}, terminal)).rejects.toThrow("middleware error");
  });

  it("should call finally hooks on error", async () => {
    const finallyHook = vi.fn();
    const middleware: Middleware[] = [
      async (ctx: any, next) => {
        await next();
      },
      Object.assign(async (ctx: any, next: any) => {
        throw new Error("error");
      }, { finally: finallyHook })
    ];

    const terminal = async () => "terminal";
    
    await expect(runMiddleware(middleware, 0, {}, terminal)).rejects.toThrow("error");
    expect(finallyHook).toHaveBeenCalledWith({}, expect.any(Error));
  });

  it("should handle empty middleware stack", async () => {
    const terminal = async () => "result";
    const result = await runMiddleware([], 0, {}, terminal);
    
    expect(result).toBe("result");
  });

  it("should pass context through middleware", async () => {
    const middleware: Middleware[] = [
      async (ctx: any, next) => {
        ctx.value = "modified";
        await next();
      }
    ];

    const terminal = async () => "result";
    const ctx: any = { value: "original" };
    const result = await runMiddleware(middleware, 0, ctx, terminal);
    
    expect(result).toBe("result");
    expect(ctx.value).toBe("modified");
  });

  it("should handle middleware that throws in finally", async () => {
    const middleware: Middleware[] = [
      Object.assign(async (ctx: any, next: any) => {
        await next();
      }, { 
        finally: async () => {
          throw new Error("finally error");
        }
      })
    ];

    const terminal = async () => "result";
    
    // Finally errors should be ignored
    const result = await runMiddleware(middleware, 0, {}, terminal);
    expect(result).toBe("result");
  });

  it("should handle nested middleware calls", async () => {
    const middleware: Middleware[] = [
      async (ctx: any, next) => {
        ctx.level1 = true;
        await next();
        ctx.level1Done = true;
      },
      async (ctx: any, next) => {
        ctx.level2 = true;
        await next();
        ctx.level2Done = true;
      }
    ];

    const terminal = async () => {
      return "result";
    };
    
    const ctx: any = {};
    const result = await runMiddleware(middleware, 0, ctx, terminal);
    
    expect(result).toBe("result");
    expect(ctx.level1).toBe(true);
    expect(ctx.level2).toBe(true);
    expect(ctx.level2Done).toBe(true);
    expect(ctx.level1Done).toBe(true);
  });
});

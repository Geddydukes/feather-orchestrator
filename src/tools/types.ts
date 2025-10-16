export interface ToolRunContext {
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface Tool<Args = any, Result = unknown> {
  name: string;
  description: string;
  cacheTtlSec?: number;
  run(args: Args, ctx: ToolRunContext): Promise<Result> | Result;
}

interface NodeStdout {
  write(chunk: string): void;
}

interface NodeProcess {
  env: Record<string, string | undefined>;
  argv: string[];
  stdout: NodeStdout;
  exit(code?: number): never;
  cwd(): string;
}

declare const process: NodeProcess;

declare const global: any;

declare module "node:crypto" {
  interface Hash {
    update(data: string | ArrayBufferView): this;
    digest(encoding?: string): string;
  }

  export function createHash(algorithm: string): Hash;
}

declare module "node:perf_hooks" {
  export const performance: { now(): number };
}

declare module "node:fs" {
  const fs: any;
  export default fs;
}

declare module "node:path" {
  const path: any;
  export default path;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}

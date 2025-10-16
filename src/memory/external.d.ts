declare module "redis" {
  export interface RedisScanIteratorOptions {
    MATCH: string;
    COUNT: number;
  }

  export interface RedisClientType {
    connect(): Promise<void>;
    quit(): Promise<void>;
    isOpen: boolean;
    exists(key: string): Promise<number>;
    hSet(key: string, value: Record<string, string | number | Buffer>): Promise<number>;
    hSet(key: string, field: string, value: string | number | Buffer): Promise<number>;
    hGet(key: string, field: string): Promise<string | null>;
    hGetAll(key: string): Promise<Record<string, string>>;
    hIncrBy(key: string, field: string, value: number): Promise<number>;
    expire(key: string, seconds: number): Promise<number>;
    rPush(key: string, values: string[]): Promise<number>;
    lTrim(key: string, start: number, stop: number): Promise<string>;
    lRange(key: string, start: number, stop: number): Promise<string[]>;
    lLen(key: string): Promise<number>;
    del(...keys: string[]): Promise<number>;
    scanIterator(options: RedisScanIteratorOptions): AsyncIterable<string>;
  }

  export interface RedisClientOptions {
    url?: string;
  }

  export function createClient(options?: RedisClientOptions): RedisClientType;
}

declare module "pg" {
  export interface PoolConfig {
    connectionString?: string;
    connectionTimeoutMillis?: number;
    idleTimeoutMillis?: number;
    max?: number;
  }

  export interface QueryResult<T = any> {
    rows: T[];
    rowCount: number;
  }

  export interface PoolClient {
    query<T = any>(text: string, params?: any[]): Promise<QueryResult<T>>;
    release(): void;
  }

  export class Pool {
    constructor(config?: PoolConfig);
    connect(): Promise<PoolClient>;
    query<T = any>(text: string, params?: any[]): Promise<QueryResult<T>>;
    end(): Promise<void>;
  }
}

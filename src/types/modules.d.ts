declare module "zod" {
  const z: any;
  namespace z {
    type infer<T> = any;
  }
  export { z };
}

declare module "vitest" {
  export const describe: any;
  export const it: any;
  export const expect: any;
  export const vi: any;
  export const beforeEach: any;
  export const afterEach: any;
}

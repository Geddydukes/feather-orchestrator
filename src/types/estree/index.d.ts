declare namespace ESTree {
  interface Node {
    type: string;
  }
}

declare module "estree" {
  export = ESTree;
}

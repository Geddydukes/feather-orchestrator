import pkg from "../package.json" with { type: "json" };

const version = typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "dev";

export const FEATHER_VERSION = version;
export const USER_AGENT = `feather-orchestrator/${FEATHER_VERSION}`;

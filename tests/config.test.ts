import { describe, it, expect } from "vitest";
import { buildRegistry } from "../src/core/config.js";
import { FeatherConfig } from "../src/core/config.js";

describe("Config Validation", () => {
  it("should validate valid config", () => {
    const config: FeatherConfig = {
      policy: "cheapest",
      providers: {
        openai: {
          apiKeyEnv: "OPENAI_API_KEY",
          baseUrl: "https://api.openai.com/v1",
          models: [
            {
              name: "gpt-4",
              aliases: ["fast"],
              inputPer1K: 0.03,
              outputPer1K: 0.06,
              capabilities: ["chat", "stream"]
            }
          ]
        }
      }
    };

    expect(() => buildRegistry(config)).not.toThrow();
  });

  it("should reject invalid policy", () => {
    const config = {
      policy: "invalid"
    };

    expect(() => buildRegistry(config)).toThrow();
  });

  it("should reject invalid baseUrl", () => {
    const config = {
      providers: {
        openai: {
          baseUrl: "not-a-url"
        }
      }
    };

    expect(() => buildRegistry(config)).toThrow();
  });

  it("should reject invalid capabilities", () => {
    const config = {
      providers: {
        openai: {
          models: [
            {
              name: "gpt-4",
              capabilities: ["invalid"]
            }
          ]
        }
      }
    };

    expect(() => buildRegistry(config)).toThrow();
  });

  it("should accept valid capabilities", () => {
    const config = {
      providers: {
        openai: {
          models: [
            {
              name: "gpt-4",
              capabilities: ["chat", "stream", "json", "tools"]
            }
          ]
        }
      }
    };

    expect(() => buildRegistry(config)).not.toThrow();
  });

  it("should handle missing optional fields", () => {
    const config = {
      providers: {
        openai: {
          models: [
            {
              name: "gpt-4"
            }
          ]
        }
      }
    };

    expect(() => buildRegistry(config)).not.toThrow();
  });

  it("should validate required fields", () => {
    const config = {
      providers: {
        openai: {
          models: [
            {
              // missing required name field
              aliases: ["test"]
            }
          ]
        }
      }
    };

    expect(() => buildRegistry(config)).toThrow();
  });

  it("should handle empty config", () => {
    expect(() => buildRegistry({})).not.toThrow();
  });

  it("should handle null/undefined config", () => {
    expect(() => buildRegistry(null)).toThrow();
    expect(() => buildRegistry(undefined)).toThrow();
  });
});

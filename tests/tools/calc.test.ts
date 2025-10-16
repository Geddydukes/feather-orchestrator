import { describe, expect, it } from "vitest";
import { createCalcTool } from "../../src/tools/calc.js";

describe("calc tool", () => {
  const tool = createCalcTool();

  it("evaluates arithmetic expressions", async () => {
    const result = await tool.run({ expression: "1 + 2 * 3" }, { metadata: {}, signal: undefined });
    expect(result).toBe(7);
  });

  it("supports variables and exponentiation", async () => {
    const result = await tool.run(
      { expression: "(base + increment) ^ power", variables: { base: 2, increment: 1, power: 3 } },
      { metadata: {}, signal: undefined }
    );
    expect(result).toBe(27);
  });

  it("applies unary negation", async () => {
    const result = await tool.run({ expression: "-1 + --(2)" }, { metadata: {}, signal: undefined });
    expect(result).toBe(1);
  });

  it("rounds results to the default precision to avoid floating drift", async () => {
    const result = await tool.run({ expression: "0.1 + 0.2" }, { metadata: {}, signal: undefined });
    expect(result).toBeCloseTo(0.3, 10);
  });

  it("rejects expressions that reference undefined variables", async () => {
    await expect(tool.run({ expression: "missing + 1" }, { metadata: {}, signal: undefined })).rejects.toThrow(
      /Variable "missing" is not defined/
    );
  });

  it("enforces expression length limits", async () => {
    const longExpression = "1 + ".repeat(600);
    await expect(tool.run({ expression: longExpression }, { metadata: {}, signal: undefined })).rejects.toThrow(
      /Expression exceeds maximum length/
    );
  });

  it("allows custom precision overrides", async () => {
    const preciseTool = createCalcTool({ defaultPrecision: 4 });
    const result = await preciseTool.run({ expression: "10 / 3", precision: 2 }, { metadata: {}, signal: undefined });
    expect(result).toBe(3.33);
  });
});

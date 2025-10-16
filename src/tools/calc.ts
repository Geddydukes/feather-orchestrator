import type { Tool, ToolRunContext } from "./types.js";

export interface CalcToolArgs {
  expression: string;
  variables?: Record<string, number>;
  precision?: number;
}

export interface CalcToolOptions {
  name?: string;
  description?: string;
  maxExpressionLength?: number;
  maxVariables?: number;
  defaultPrecision?: number;
}

const DEFAULT_NAME = "calc";
const DEFAULT_DESCRIPTION = "Evaluate deterministic arithmetic expressions with optional named variables.";
const DEFAULT_MAX_LENGTH = 512;
const DEFAULT_MAX_VARIABLES = 32;
const DEFAULT_PRECISION = 12;

const OPERATORS: Record<string, { precedence: number; associativity: "left" | "right"; unary?: boolean }> = {
  "+": { precedence: 1, associativity: "left" },
  "-": { precedence: 1, associativity: "left" },
  "*": { precedence: 2, associativity: "left" },
  "/": { precedence: 2, associativity: "left" },
  "%": { precedence: 2, associativity: "left" },
  "^": { precedence: 3, associativity: "right" },
  "neg": { precedence: 4, associativity: "right", unary: true },
};

const SUPPORTED_OPERATOR_SET = new Set(Object.keys(OPERATORS));

export function createCalcTool(options: CalcToolOptions = {}): Tool<CalcToolArgs, number> {
  const name = options.name?.trim() || DEFAULT_NAME;
  const description = options.description?.trim() || DEFAULT_DESCRIPTION;
  const maxExpressionLength = options.maxExpressionLength ?? DEFAULT_MAX_LENGTH;
  const maxVariables = options.maxVariables ?? DEFAULT_MAX_VARIABLES;
  const defaultPrecision = options.defaultPrecision ?? DEFAULT_PRECISION;

  if (maxExpressionLength <= 0) {
    throw new Error("maxExpressionLength must be positive");
  }
  if (maxVariables <= 0) {
    throw new Error("maxVariables must be positive");
  }
  if (!Number.isInteger(maxVariables)) {
    throw new Error("maxVariables must be an integer");
  }
  if (!Number.isFinite(defaultPrecision) || defaultPrecision < 0 || defaultPrecision > 15) {
    throw new Error("defaultPrecision must be between 0 and 15");
  }

  return {
    name,
    description,
    async run(args: CalcToolArgs, _ctx: ToolRunContext): Promise<number> {
      if (!args || typeof args.expression !== "string") {
        throw new Error("calc tool requires an expression string");
      }
      const expression = args.expression.trim();
      if (expression.length === 0) {
        throw new Error("Expression cannot be empty");
      }
      if (expression.length > maxExpressionLength) {
        throw new Error(`Expression exceeds maximum length of ${maxExpressionLength} characters`);
      }

      const variables = normalizeVariables(args.variables, maxVariables);
      const precision = normalisePrecision(args.precision ?? defaultPrecision);
      const tokens = tokenize(expression);
      const rpn = toReversePolishNotation(tokens);
      const result = evaluateRpn(rpn, variables);
      if (!Number.isFinite(result)) {
        throw new Error("Expression evaluated to a non-finite value");
      }
      const rounded = Number(result.toFixed(precision));
      return Number.isFinite(rounded) ? rounded : result;
    },
  } satisfies Tool<CalcToolArgs, number>;
}

type Token =
  | { type: "number"; value: number }
  | { type: "variable"; name: string }
  | { type: "operator"; value: string }
  | { type: "paren"; value: "(" | ")" };

function normalizeVariables(variables: Record<string, number> | undefined, maxVariables: number): Record<string, number> {
  if (!variables) {
    return {};
  }
  const entries = Object.entries(variables);
  if (entries.length > maxVariables) {
    throw new Error(`Too many variables provided (max ${maxVariables})`);
  }
  const result: Record<string, number> = {};
  for (const [name, value] of entries) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      throw new Error(`Invalid variable name: ${name}`);
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Variable \"${name}\" must be a finite number`);
    }
    result[name] = value;
  }
  return result;
}

function normalisePrecision(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 15) {
    throw new Error("precision must be between 0 and 15");
  }
  return Math.floor(value);
}

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let lastToken: Token | undefined;

  while (index < expression.length) {
    const char = expression[index];

    if (char === " " || char === "\n" || char === "\t") {
      index += 1;
      continue;
    }

    if (/[0-9.]/.test(char)) {
      const start = index;
      while (index < expression.length && /[0-9.]/.test(expression[index])) {
        index += 1;
      }
      const raw = expression.slice(start, index);
      if ((raw.match(/\./g) ?? []).length > 1) {
        throw new Error(`Invalid number literal: ${raw}`);
      }
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new Error(`Invalid number literal: ${raw}`);
      }
      tokens.push({ type: "number", value });
      lastToken = tokens[tokens.length - 1];
      continue;
    }

    if (/[a-zA-Z_]/.test(char)) {
      const start = index;
      index += 1;
      while (index < expression.length && /[a-zA-Z0-9_]/.test(expression[index])) {
        index += 1;
      }
      const name = expression.slice(start, index);
      tokens.push({ type: "variable", name });
      lastToken = tokens[tokens.length - 1];
      continue;
    }

    if (char === "(" || char === ")") {
      tokens.push({ type: "paren", value: char });
      lastToken = tokens[tokens.length - 1];
      index += 1;
      continue;
    }

    if (char === "*" && expression[index + 1] === "*") {
      tokens.push({ type: "operator", value: "^" });
      lastToken = tokens[tokens.length - 1];
      index += 2;
      continue;
    }

    if (SUPPORTED_OPERATOR_SET.has(char)) {
      let operator = char;
      if (char === "-" && (lastToken === undefined || isOperator(lastToken) || isLeftParen(lastToken))) {
        operator = "neg";
      }
      tokens.push({ type: "operator", value: operator });
      lastToken = tokens[tokens.length - 1];
      index += 1;
      continue;
    }

    throw new Error(`Unsupported character in expression: ${char}`);
  }

  return tokens;
}

function toReversePolishNotation(tokens: Token[]): Token[] {
  const output: Token[] = [];
  const operatorStack: Token[] = [];

  for (const token of tokens) {
    if (token.type === "number" || token.type === "variable") {
      output.push(token);
      continue;
    }

    if (token.type === "operator") {
      const operatorMeta = OPERATORS[token.value];
      if (!operatorMeta) {
        throw new Error(`Unsupported operator: ${token.value}`);
      }
      while (operatorStack.length > 0) {
        const top = operatorStack[operatorStack.length - 1];
        if (top.type !== "operator") {
          break;
        }
        const topMeta = OPERATORS[top.value];
        if (!topMeta) {
          break;
        }
        const precedenceCheck =
          (operatorMeta.associativity === "left" && operatorMeta.precedence <= topMeta.precedence) ||
          (operatorMeta.associativity === "right" && operatorMeta.precedence < topMeta.precedence);
        if (!precedenceCheck) {
          break;
        }
        output.push(operatorStack.pop()!);
      }
      operatorStack.push(token);
      continue;
    }

    if (token.type === "paren") {
      if (token.value === "(") {
        operatorStack.push(token);
      } else {
        while (operatorStack.length > 0 && !isLeftParen(operatorStack[operatorStack.length - 1])) {
          output.push(operatorStack.pop()!);
        }
        if (operatorStack.length === 0 || !isLeftParen(operatorStack[operatorStack.length - 1])) {
          throw new Error("Mismatched parentheses");
        }
        operatorStack.pop();
      }
      continue;
    }
  }

  while (operatorStack.length > 0) {
    const token = operatorStack.pop()!;
    if (token.type === "paren") {
      throw new Error("Mismatched parentheses");
    }
    output.push(token);
  }

  return output;
}

function evaluateRpn(tokens: Token[], variables: Record<string, number>): number {
  const stack: number[] = [];

  for (const token of tokens) {
    if (token.type === "number") {
      stack.push(token.value);
      continue;
    }
    if (token.type === "variable") {
      if (!(token.name in variables)) {
        throw new Error(`Variable \"${token.name}\" is not defined`);
      }
      stack.push(variables[token.name]);
      continue;
    }
    if (token.type === "operator") {
      const meta = OPERATORS[token.value];
      if (!meta) {
        throw new Error(`Unsupported operator: ${token.value}`);
      }
      if (meta.unary) {
        if (stack.length < 1) {
          throw new Error(`Operator ${token.value} is missing an operand`);
        }
        const value = stack.pop()!;
        stack.push(applyUnaryOperator(token.value, value));
        continue;
      }
      if (stack.length < 2) {
        throw new Error(`Operator ${token.value} is missing an operand`);
      }
      const right = stack.pop()!;
      const left = stack.pop()!;
      stack.push(applyBinaryOperator(token.value, left, right));
      continue;
    }
    throw new Error("Unexpected token in evaluation");
  }

  if (stack.length !== 1) {
    throw new Error("Expression did not reduce to a single value");
  }

  return stack[0];
}

function applyUnaryOperator(operator: string, value: number): number {
  if (operator === "neg") {
    return -value;
  }
  throw new Error(`Unsupported unary operator: ${operator}`);
}

function applyBinaryOperator(operator: string, left: number, right: number): number {
  switch (operator) {
    case "+":
      return left + right;
    case "-":
      return left - right;
    case "*":
      return left * right;
    case "/":
      if (right === 0) {
        throw new Error("Division by zero");
      }
      return left / right;
    case "%":
      if (right === 0) {
        throw new Error("Modulo by zero");
      }
      return left % right;
    case "^":
      return Math.pow(left, right);
    default:
      throw new Error(`Unsupported operator: ${operator}`);
  }
}

function isOperator(token: Token): boolean {
  return token.type === "operator";
}

function isLeftParen(token: Token): boolean {
  return token.type === "paren" && token.value === "(";
}

import type { Message } from "../types.js";
import type { AgentMemoryTurn, AgentMessage } from "./types.js";

export function turnsToMessages(turns: readonly AgentMemoryTurn[]): Message[] {
  return turns
    .map((turn) => toMessage(turn))
    .filter((message): message is Message => message !== null);
}

export function agentMessagesToMessages(messages: readonly AgentMessage[]): Message[] {
  return messages.map((message) => fromAgentMessage(message));
}

function toMessage(turn: AgentMemoryTurn): Message | null {
  if (turn.role === "summary") {
    return {
      role: "system",
      content: stringify(turn.content),
    } satisfies Message;
  }

  const content = turn.content;
  if (!isAgentMessage(content)) {
    return {
      role: "system",
      content: stringify(content),
    } satisfies Message;
  }

  return fromAgentMessage(content);
}

function isAgentMessage(value: unknown): value is AgentMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "role" in value &&
    typeof (value as { role?: unknown }).role === "string"
  );
}

function fromAgentMessage(message: AgentMessage): Message {
  switch (message.role) {
    case "system":
    case "assistant":
    case "user": {
      return {
        role: message.role,
        content: stringify(message.content),
      } satisfies Message;
    }
    case "tool": {
      return {
        role: "tool",
        content: stringify({ tool: message.name, output: message.content }),
      } satisfies Message;
    }
    default: {
      return {
        role: "system",
        content: stringify(message),
      } satisfies Message;
    }
  }
}

function stringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch (error) {
    return String(value);
  }
}

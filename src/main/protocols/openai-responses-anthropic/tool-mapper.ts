import type { AnthropicTool } from "./types";

export function mapAnthropicToolsToResponsesTools(tools: AnthropicTool[]): unknown[] {
  return tools
    .filter((tool) => tool.type !== "BatchTool")
    .flatMap(mapAnthropicToolToResponsesTools);
}

export function mapAnthropicToolToResponsesTools(tool: AnthropicTool): unknown[] {
  const name = typeof tool.name === "string" ? tool.name : "";
  if (!name) return [];

  if (isWebSearchToolName(name)) {
    return [{ type: "web_search" }];
  }

  return [{
    type: "function",
    name,
    description: tool.description,
    parameters: cleanJsonSchema(tool.input_schema || {}),
  }];
}

export function mapToolChoiceToResponses(toolChoice: unknown): unknown {
  if (toolChoice === undefined) return undefined;
  if (typeof toolChoice === "string") return toolChoice;
  const object = recordOf(toolChoice);
  const type = stringOf(object.type);
  if (type === "any") return "required";
  if (type === "auto") return "auto";
  if (type === "none") return "none";
  if (type === "tool") {
    const name = stringOf(object.name);
    return isWebSearchToolName(name) ? { type: "web_search" } : { type: "function", name };
  }
  return toolChoice;
}

export function isWebSearchToolName(name: string): boolean {
  return name === "WebSearch" || name === "web_search";
}

export function sanitizeAnthropicToolUseInput(name: string, input: unknown): unknown {
  if (name !== "Read") return input;
  const object = recordOf(input);
  if (object.pages === "") {
    const next = { ...object };
    delete next.pages;
    return next;
  }
  return input;
}

function cleanJsonSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(cleanJsonSchema);
  const object = schema as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(object)
      .filter(([key]) => key !== "cache_control")
      .map(([key, value]) => [key, cleanJsonSchema(value)]),
  );
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

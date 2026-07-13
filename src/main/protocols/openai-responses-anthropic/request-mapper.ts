import { mapAnthropicToolsToResponsesTools, mapToolChoiceToResponses } from "./tool-mapper";
import type { AnthropicMessage, AnthropicMessagesRequest, JsonValue, OpenAiResponsesRequest } from "./types";

export function anthropicToOpenAiResponses(body: AnthropicMessagesRequest): OpenAiResponsesRequest {
  const result: OpenAiResponsesRequest = {};

  if (typeof body.model === "string" && body.model.trim()) result.model = body.model;

  const instructions = normalizeSystemInstructions(body.system);
  if (instructions) result.instructions = instructions;

  if (Array.isArray(body.messages)) result.input = convertMessagesToResponsesInput(body.messages);
  if (typeof body.max_tokens === "number") result.max_output_tokens = body.max_tokens;
  if (typeof body.temperature === "number") result.temperature = body.temperature;
  if (typeof body.top_p === "number") result.top_p = body.top_p;
  if (typeof body.stream === "boolean") result.stream = body.stream;

  if (Array.isArray(body.tools)) {
    const tools = mapAnthropicToolsToResponsesTools(body.tools);
    if (tools.length > 0) result.tools = tools;
    if (tools.some(isHostedWebSearchTool)) result.include = ["web_search_call.action.sources"];
  }

  const toolChoice = mapToolChoiceToResponses(body.tool_choice);
  if (toolChoice !== undefined) result.tool_choice = toolChoice;

  return result;
}

function normalizeSystemInstructions(system: AnthropicMessagesRequest["system"]): string {
  if (typeof system === "string") return stripLeadingAnthropicBillingHeader(system).trim();
  if (!Array.isArray(system)) return "";
  return system
    .flatMap((part) => typeof part.text === "string" ? [stripLeadingAnthropicBillingHeader(part.text).trim()] : [])
    .filter(Boolean)
    .join("\n\n");
}

function convertMessagesToResponsesInput(messages: AnthropicMessage[]): unknown[] {
  const input: unknown[] = [];
  for (const message of messages) {
    const role = typeof message.role === "string" ? message.role : "user";
    const content = message.content;

    if (typeof content === "string") {
      input.push({
        role,
        content: [{ type: role === "assistant" ? "output_text" : "input_text", text: content }],
      });
      continue;
    }

    if (!Array.isArray(content)) {
      input.push({ role });
      continue;
    }

    let messageContent: unknown[] = [];
    const flushMessageContent = () => {
      if (messageContent.length === 0) return;
      input.push({ role, content: messageContent });
      messageContent = [];
    };

    for (const block of content) {
      if (block.type === "text") {
        const text = typeof block.text === "string" ? block.text : "";
        if (text) messageContent.push({ type: role === "assistant" ? "output_text" : "input_text", text });
        continue;
      }

      if (block.type === "image") {
        const source = recordOf(block.source);
        const mediaType = stringOf(source.media_type) || "image/png";
        const data = stringOf(source.data);
        if (data) messageContent.push({ type: "input_image", image_url: `data:${mediaType};base64,${data}` });
        continue;
      }

      if (block.type === "tool_use") {
        flushMessageContent();
        input.push({
          type: "function_call",
          call_id: block.id || "",
          name: block.name || "",
          arguments: stableJsonStringify(block.input ?? {}),
        });
        continue;
      }

      if (block.type === "tool_result") {
        flushMessageContent();
        input.push({
          type: "function_call_output",
          call_id: block.tool_use_id || "",
          output: typeof block.content === "string" ? block.content : stableJsonStringify(block.content ?? ""),
        });
      }
    }

    flushMessageContent();
  }
  return input;
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value as JsonValue));
}

function sortJsonValue(value: JsonValue): JsonValue {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortJsonValue);
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, sortJsonValue(nested)]),
  );
}

function stripLeadingAnthropicBillingHeader(value: string): string {
  return value.replace(/^x-anthropic-billing-header:[^\n\r]*(?:\r?\n){1,2}/, "");
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isHostedWebSearchTool(tool: unknown): boolean {
  const object = recordOf(tool);
  return stringOf(object.type) === "web_search" || stringOf(object.type) === "web_search_preview";
}

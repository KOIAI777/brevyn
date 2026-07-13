import { buildAnthropicUsageFromResponses, buildBrevynUsageFromResponses, mapResponsesStopReason, responseErrorMessage } from "./errors";
import { sanitizeAnthropicToolUseInput } from "./tool-mapper";
import type { AnthropicMessagesResponse, AnthropicResponseContentBlock } from "./types";
import { hostedWebSearchInput } from "./web-search-mapper";

export function openAiResponsesToAnthropic(body: unknown): AnthropicMessagesResponse {
  const object = recordOf(body);
  if (stringOf(object.status) === "failed") {
    throw new Error(responseErrorMessage(object));
  }
  const output = arrayOf(object.output);
  if (!output) throw new Error("OpenAI Responses payload is missing output[]");

  const content: AnthropicResponseContentBlock[] = [];
  let hasToolUse = false;

  for (const item of output) {
    const itemObject = recordOf(item);
    const itemType = stringOf(itemObject.type);

    if (itemType === "message") {
      for (const block of arrayOf(itemObject.content) || []) {
        const blockObject = recordOf(block);
        const blockType = stringOf(blockObject.type);
        if (blockType === "output_text") {
          const text = stringOf(blockObject.text);
          if (text) {
            const citations = annotationsToAnthropicCitations(arrayOf(blockObject.annotations) || []);
            content.push(citations.length > 0 ? { type: "text", text, citations } : { type: "text", text });
          }
        } else if (blockType === "refusal") {
          const refusal = stringOf(blockObject.refusal) || stringOf(blockObject.text);
          if (refusal) content.push({ type: "text", text: refusal });
        }
      }
      continue;
    }

    if (itemType === "function_call") {
      const id = stringOf(itemObject.call_id) || stringOf(itemObject.id);
      const name = stringOf(itemObject.name);
      const input = sanitizeAnthropicToolUseInput(name, parseJsonObjectString(stringOf(itemObject.arguments)));
      content.push({ type: "tool_use", id, name, input });
      hasToolUse = true;
      continue;
    }

    if (itemType === "web_search_call") {
      content.push({
        type: "server_tool_use",
        id: stringOf(itemObject.id),
        name: "WebSearch",
        input: hostedWebSearchInput(itemObject),
      });
      continue;
    }

    if (itemType === "reasoning") {
      const thinking = extractReasoningSummary(itemObject);
      if (thinking) content.push({ type: "thinking", thinking });
    }
  }

  return {
    id: stringOf(object.id),
    type: "message",
    role: "assistant",
    content,
    model: stringOf(object.model),
    stop_reason: mapResponsesStopReason(stringOf(object.status), hasToolUse, stringOf(recordOf(object.incomplete_details).reason)),
    stop_sequence: null,
    usage: buildAnthropicUsageFromResponses(object.usage),
    _brevynUsage: buildBrevynUsageFromResponses(object.usage, stringOf(object.model)),
  };
}

function extractReasoningSummary(item: Record<string, unknown>): string {
  const summary = arrayOf(item.summary);
  if (summary) {
    return summary
      .flatMap((part) => {
        const object = recordOf(part);
        return stringOf(object.type) === "summary_text" ? [stringOf(object.text)] : [];
      })
      .join("");
  }
  return stringOf(item.text) || stringOf(item.reasoning);
}

function annotationsToAnthropicCitations(annotations: unknown[]): Record<string, unknown>[] {
  return annotations.flatMap((item) => {
    const annotation = recordOf(item);
    if (stringOf(annotation.type) !== "url_citation") return [];
    const url = stringOf(annotation.url);
    if (!url) return [];
    const title = stringOf(annotation.title) || url;
    const citedText = stringOf(annotation.cited_text) || stringOf(annotation.text);
    return [{
      type: "web_search_result_location",
      url,
      title,
      ...(citedText ? { cited_text: citedText } : {}),
      start_index: numberOf(annotation.start_index),
      end_index: numberOf(annotation.end_index),
    }];
  });
}

function parseJsonObjectString(value: string): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayOf(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

import { buildAnthropicUsageFromResponses, buildBrevynUsageFromResponses, mapResponsesStopReason, responseErrorMessage, responseObject } from "./errors";
import { sanitizeAnthropicToolUseInput } from "./tool-mapper";
import { hostedWebSearchInput } from "./web-search-mapper";
import { formatSseEvent, parseSseBlock } from "../sse";

interface StreamState {
  messageId?: string;
  model?: string;
  messageStarted: boolean;
  hasToolUse: boolean;
  nextContentIndex: number;
  openIndices: Set<number>;
  indexByKey: Map<string, number>;
  currentTextIndex?: number;
  fallbackOpenIndex?: number;
  toolIndexByItemId: Map<string, number>;
  toolIndexByCallId: Map<string, number>;
  toolNameByIndex: Map<number, string>;
  toolArgsByIndex: Map<number, string>;
  toolArgsStreamedByIndex: Set<number>;
  hostedToolIndexByItemId: Map<string, number>;
  hostedToolInputByIndex: Map<number, Record<string, unknown>>;
  emittedCitationKeys: Set<string>;
}

export function openAiResponsesSseToAnthropicSse(input: string): string {
  const transformer = new OpenAiResponsesToAnthropicSseTransformer();
  return transformer.push(input) + transformer.flush();
}

export class OpenAiResponsesToAnthropicSseTransformer {
  private readonly state: StreamState = {
    messageStarted: false,
    hasToolUse: false,
    nextContentIndex: 0,
    openIndices: new Set(),
    indexByKey: new Map(),
    toolIndexByItemId: new Map(),
    toolIndexByCallId: new Map(),
    toolNameByIndex: new Map(),
    toolArgsByIndex: new Map(),
    toolArgsStreamedByIndex: new Set(),
    hostedToolIndexByItemId: new Map(),
    hostedToolInputByIndex: new Map(),
    emittedCitationKeys: new Set(),
  };
  private buffer = "";
  private readonly decoder = new TextDecoder();

  push(chunk: string | Uint8Array): string {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    const output: string[] = [];

    while (true) {
      const boundary = sseBoundaryIndex(this.buffer);
      if (boundary < 0) break;
      const block = this.buffer.slice(0, boundary);
      const separatorLength = this.buffer.startsWith("\r\n\r\n", boundary) ? 4 : 2;
      this.buffer = this.buffer.slice(boundary + separatorLength);
      this.handleBlock(block, output);
    }

    return output.join("");
  }

  flush(): string {
    const output: string[] = [];
    this.buffer += this.decoder.decode();
    if (this.buffer.trim()) this.handleBlock(this.buffer, output);
    this.buffer = "";
    return output.join("");
  }

  private handleBlock(block: string, output: string[]): void {
    const event = parseSseBlock(block);
    if (!event?.data || event.data === "[DONE]") return;

    let data: unknown;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    const eventName = event.event || stringOf(recordOf(data).type);
    handleResponsesEvent(eventName, data, this.state, output);
  }
}

function sseBoundaryIndex(value: string): number {
  const lf = value.indexOf("\n\n");
  const crlf = value.indexOf("\r\n\r\n");
  if (lf < 0) return crlf;
  if (crlf < 0) return lf;
  return Math.min(lf, crlf);
}

function handleResponsesEvent(eventName: string, data: unknown, state: StreamState, output: string[]): void {
  const object = recordOf(data);
  switch (eventName) {
    case "response.created": {
      const response = responseObject(object);
      state.messageId = stringOf(response.id) || state.messageId;
      state.model = stringOf(response.model) || state.model;
      emitMessageStart(state, output, response.usage);
      break;
    }

    case "response.content_part.added": {
      const part = recordOf(object.part);
      const partType = stringOf(part.type);
      if (partType !== "output_text" && partType !== "refusal") break;
      emitMessageStart(state, output);
      const index = resolveTextIndex(object, state);
      openTextBlock(index, state, output);
      break;
    }

    case "response.output_text.delta":
    case "response.refusal.delta": {
      const delta = stringOf(object.delta);
      if (!delta) break;
      emitMessageStart(state, output);
      const index = resolveTextIndex(object, state);
      openTextBlock(index, state, output);
      output.push(formatSseEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: delta },
      }));
      break;
    }

    case "response.output_text.done":
    case "response.refusal.done": {
      emitCitationDeltasFromObject(object, state, output);
      closeCurrentTextBlock(object, state, output);
      break;
    }

    case "response.output_text.annotation.added": {
      emitCitationDeltasFromObject(object, state, output);
      break;
    }

    case "response.output_item.added": {
      const item = recordOf(object.item);
      if (stringOf(item.type) === "web_search_call") {
        closeCurrentTextBlock(object, state, output);
        emitMessageStart(state, output);
        const index = resolveHostedToolIndexFromAdded(object, item, state);
        const itemId = stringOf(item.id) || stringOf(object.item_id);
        if (itemId) state.hostedToolIndexByItemId.set(itemId, index);
        state.hostedToolInputByIndex.set(index, hostedWebSearchInput(item, "in_progress"));
        openHostedWebSearchBlock(index, item, state, output);
        break;
      }

      if (stringOf(item.type) !== "function_call") break;
      closeCurrentTextBlock(object, state, output);
      emitMessageStart(state, output);
      state.hasToolUse = true;

      const index = resolveToolIndexFromAdded(object, item, state);
      const itemId = stringOf(item.id) || stringOf(object.item_id);
      if (itemId) state.toolIndexByItemId.set(itemId, index);
      const callId = stringOf(item.call_id);
      if (callId) state.toolIndexByCallId.set(callId, index);
      state.toolNameByIndex.set(index, stringOf(item.name));
      if (!state.toolArgsByIndex.has(index)) state.toolArgsByIndex.set(index, "");

      if (!state.openIndices.has(index)) {
        output.push(formatSseEvent("content_block_start", {
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: stringOf(item.call_id),
            name: stringOf(item.name),
          },
        }));
        state.openIndices.add(index);
      }
      break;
    }

    case "response.web_search_call.in_progress":
    case "response.web_search_call.searching":
    case "response.web_search_call.completed": {
      closeCurrentTextBlock(object, state, output);
      emitMessageStart(state, output);
      const status = eventName.endsWith(".completed") ? "completed" : eventName.endsWith(".searching") ? "searching" : "in_progress";
      const index = resolveHostedToolIndexFromEvent(object, state);
      const previous = state.hostedToolInputByIndex.get(index) || {};
      state.hostedToolInputByIndex.set(index, {
        ...previous,
        ...hostedWebSearchInput(object, status),
      });
      openHostedWebSearchBlock(index, object, state, output);
      if (status === "completed") {
        output.push(formatSseEvent("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(state.hostedToolInputByIndex.get(index) || hostedWebSearchInput(object, status)),
          },
        }));
        closeBlock(index, state, output);
      }
      break;
    }

    case "response.function_call_arguments.delta": {
      const delta = stringOf(object.delta);
      if (!delta) break;
      emitMessageStart(state, output);
      const index = resolveToolIndexFromEvent(object, state) ?? state.nextContentIndex++;
      const eventName = stringOf(object.name);
      if (eventName && !state.toolNameByIndex.has(index)) state.toolNameByIndex.set(index, eventName);
      if (!state.openIndices.has(index)) {
        output.push(formatSseEvent("content_block_start", {
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: stringOf(object.call_id) || stringOf(object.item_id),
            name: stringOf(object.name),
          },
        }));
        state.openIndices.add(index);
      }

      const name = state.toolNameByIndex.get(index) || eventName;
      state.toolArgsByIndex.set(index, `${state.toolArgsByIndex.get(index) || ""}${delta}`);
      if (name === "Read") {
        break;
      }

      state.toolArgsStreamedByIndex.add(index);
      output.push(formatSseEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: delta },
      }));
      break;
    }

    case "response.function_call_arguments.done": {
      const index = resolveToolIndexFromEvent(object, state, false);
      if (index === undefined) break;
      const name = state.toolNameByIndex.get(index) || "";
      if (name === "Read" || !state.toolArgsStreamedByIndex.has(index)) {
        const raw = stringOf(object.arguments) || state.toolArgsByIndex.get(index) || "";
        const sanitized = sanitizeToolArgsJson(name, raw);
        if (sanitized) {
          output.push(formatSseEvent("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: sanitized },
          }));
        }
      }
      closeBlock(index, state, output);
      if (stringOf(object.item_id)) state.toolIndexByItemId.delete(stringOf(object.item_id));
      if (stringOf(object.call_id)) state.toolIndexByCallId.delete(stringOf(object.call_id));
      state.toolNameByIndex.delete(index);
      state.toolArgsByIndex.delete(index);
      state.toolArgsStreamedByIndex.delete(index);
      break;
    }

    case "response.content_part.done": {
      emitCitationDeltasFromObject(object, state, output);
      const index = indexForContentKey(object, state);
      if (index !== undefined) closeBlock(index, state, output);
      if (state.currentTextIndex === index) state.currentTextIndex = undefined;
      if (state.fallbackOpenIndex === index) state.fallbackOpenIndex = undefined;
      break;
    }

    case "response.output_item.done": {
      handleOutputItemDone(object, state, output);
      break;
    }

    case "response.reasoning.delta":
    case "response.reasoning_text.delta":
    case "response.reasoning_summary_text.delta": {
      const delta = stringOf(object.delta) || stringOf(object.text);
      if (!delta) break;
      closeCurrentTextBlock(object, state, output);
      emitMessageStart(state, output);
      const index = resolveContentIndex(object, state);
      if (!state.openIndices.has(index)) {
        output.push(formatSseEvent("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "thinking", thinking: "" },
        }));
        state.openIndices.add(index);
      }
      output.push(formatSseEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: delta },
      }));
      break;
    }

    case "response.reasoning.done": {
      const index = indexForContentKey(object, state) ?? state.fallbackOpenIndex;
      if (index !== undefined) closeBlock(index, state, output);
      if (state.fallbackOpenIndex === index) state.fallbackOpenIndex = undefined;
      break;
    }

    case "response.reasoning_text.done":
    case "response.reasoning_summary_text.done": {
      const index = indexForContentKey(object, state) ?? state.fallbackOpenIndex;
      if (index !== undefined) closeBlock(index, state, output);
      if (state.fallbackOpenIndex === index) state.fallbackOpenIndex = undefined;
      break;
    }

    case "response.completed": {
      const response = responseObject(object);
      closeAllOpenBlocks(state, output);
      output.push(formatSseEvent("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: mapResponsesStopReason(
            stringOf(response.status),
            state.hasToolUse,
            stringOf(recordOf(response.incomplete_details).reason),
          ),
          stop_sequence: null,
        },
        usage: buildAnthropicUsageFromResponses(response.usage),
        _brevynUsage: buildBrevynUsageFromResponses(response.usage, stringOf(response.model) || state.model),
      }));
      output.push(formatSseEvent("message_stop", { type: "message_stop" }));
      break;
    }

    case "response.incomplete": {
      const response = responseObject(object);
      closeAllOpenBlocks(state, output);
      if (state.messageStarted) {
        output.push(formatSseEvent("message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: mapResponsesStopReason(
              stringOf(response.status) || "incomplete",
              state.hasToolUse,
              stringOf(recordOf(response.incomplete_details).reason),
            ),
            stop_sequence: null,
          },
          usage: buildAnthropicUsageFromResponses(response.usage),
          _brevynUsage: buildBrevynUsageFromResponses(response.usage, stringOf(response.model) || state.model),
        }));
        output.push(formatSseEvent("message_stop", { type: "message_stop" }));
      }
      break;
    }

    case "response.failed": {
      closeAllOpenBlocks(state, output);
      output.push(formatSseEvent("error", {
        type: "error",
        error: {
          type: "api_error",
          message: responseErrorMessage(object),
        },
      }));
      break;
    }

    default:
      break;
  }
}

function emitMessageStart(state: StreamState, output: string[], usage?: unknown): void {
  if (state.messageStarted) return;
  output.push(formatSseEvent("message_start", {
    type: "message_start",
    message: {
      id: state.messageId || "",
      type: "message",
      role: "assistant",
      model: state.model || "",
      usage: buildAnthropicUsageFromResponses(usage),
      _brevynUsage: buildBrevynUsageFromResponses(usage, state.model),
    },
  }));
  state.messageStarted = true;
}

function openTextBlock(index: number, state: StreamState, output: string[]): void {
  if (state.openIndices.has(index)) return;
  output.push(formatSseEvent("content_block_start", {
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "" },
  }));
  state.openIndices.add(index);
}

function emitCitationDeltasFromObject(object: Record<string, unknown>, state: StreamState, output: string[]): void {
  const annotations = annotationsFromObject(object);
  if (annotations.length === 0) return;
  emitMessageStart(state, output);
  const index = resolveTextIndex(object, state);
  openTextBlock(index, state, output);
  for (const annotation of annotations) {
    const citation = anthropicCitationFromResponsesAnnotation(annotation);
    if (!citation) continue;
    const key = citationKey(object, citation);
    if (state.emittedCitationKeys.has(key)) continue;
    state.emittedCitationKeys.add(key);
    output.push(formatSseEvent("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: {
        type: "citations_delta",
        citation,
      },
    }));
  }
}

function closeCurrentTextBlock(object: Record<string, unknown>, state: StreamState, output: string[]): void {
  const index = state.currentTextIndex ?? indexForContentKey(object, state) ?? state.fallbackOpenIndex;
  if (index === undefined) return;
  closeBlock(index, state, output);
  if (state.currentTextIndex === index) state.currentTextIndex = undefined;
  if (state.fallbackOpenIndex === index) state.fallbackOpenIndex = undefined;
}

function closeBlock(index: number, state: StreamState, output: string[]): void {
  if (!state.openIndices.delete(index)) return;
  output.push(formatSseEvent("content_block_stop", {
    type: "content_block_stop",
    index,
  }));
}

function closeAllOpenBlocks(state: StreamState, output: string[]): void {
  for (const index of [...state.openIndices].sort((a, b) => a - b)) closeBlock(index, state, output);
  state.currentTextIndex = undefined;
  state.fallbackOpenIndex = undefined;
}

function openHostedWebSearchBlock(index: number, item: Record<string, unknown>, state: StreamState, output: string[]): void {
  if (state.openIndices.has(index)) return;
  const existingInput = state.hostedToolInputByIndex.get(index) || {};
  const input = {
    ...hostedWebSearchInput(item, stringOf(existingInput.status) || "in_progress"),
    ...existingInput,
    hosted: true,
  };
  state.hostedToolInputByIndex.set(index, input);
  output.push(formatSseEvent("content_block_start", {
    type: "content_block_start",
    index,
    content_block: {
      type: "server_tool_use",
      id: stringOf(item.id) || stringOf(item.item_id) || `web_search_${index}`,
      name: "WebSearch",
      input,
    },
  }));
  state.openIndices.add(index);
}

function resolveTextIndex(object: Record<string, unknown>, state: StreamState): number {
  if (state.currentTextIndex !== undefined) return state.currentTextIndex;
  const index = resolveContentIndex(object, state);
  state.currentTextIndex = index;
  return index;
}

function resolveContentIndex(object: Record<string, unknown>, state: StreamState): number {
  const key = contentPartKey(object);
  if (key) {
    const existing = state.indexByKey.get(key);
    if (existing !== undefined) return existing;
    const assigned = state.nextContentIndex++;
    state.indexByKey.set(key, assigned);
    return assigned;
  }
  if (state.fallbackOpenIndex !== undefined) return state.fallbackOpenIndex;
  const assigned = state.nextContentIndex++;
  state.fallbackOpenIndex = assigned;
  return assigned;
}

function resolveToolIndexFromAdded(object: Record<string, unknown>, item: Record<string, unknown>, state: StreamState): number {
  const key = toolItemKey(object, item);
  if (key) return assignIndexForKey(key, state);
  return state.nextContentIndex++;
}

function resolveToolIndexFromEvent(object: Record<string, unknown>, state: StreamState, create = true): number | undefined {
  const itemId = stringOf(object.item_id);
  if (itemId && state.toolIndexByItemId.has(itemId)) return state.toolIndexByItemId.get(itemId);

  const callId = stringOf(object.call_id);
  if (callId && state.toolIndexByCallId.has(callId)) return state.toolIndexByCallId.get(callId);

  const key = itemId ? `tool:${itemId}` : outputIndexKey("tool", object);
  if (key && state.indexByKey.has(key)) return state.indexByKey.get(key);

  if (!create) return undefined;

  const assigned = state.nextContentIndex++;
  if (itemId) {
    state.indexByKey.set(`tool:${itemId}`, assigned);
    state.toolIndexByItemId.set(itemId, assigned);
  } else if (key) {
    state.indexByKey.set(key, assigned);
  }
  if (callId) state.toolIndexByCallId.set(callId, assigned);
  return assigned;
}

function resolveHostedToolIndexFromAdded(object: Record<string, unknown>, item: Record<string, unknown>, state: StreamState): number {
  const key = stringOf(item.id) ? `hosted:${stringOf(item.id)}` : stringOf(object.item_id) ? `hosted:${stringOf(object.item_id)}` : outputIndexKey("hosted", object);
  if (key) return assignIndexForKey(key, state);
  return state.nextContentIndex++;
}

function resolveHostedToolIndexFromEvent(object: Record<string, unknown>, state: StreamState): number {
  const itemId = stringOf(object.item_id) || stringOf(object.id);
  if (itemId && state.hostedToolIndexByItemId.has(itemId)) return state.hostedToolIndexByItemId.get(itemId) as number;
  const key = itemId ? `hosted:${itemId}` : outputIndexKey("hosted", object);
  if (key && state.indexByKey.has(key)) return state.indexByKey.get(key) as number;
  const assigned = state.nextContentIndex++;
  if (itemId) {
    state.hostedToolIndexByItemId.set(itemId, assigned);
    state.indexByKey.set(`hosted:${itemId}`, assigned);
  }
  return assigned;
}

function handleOutputItemDone(object: Record<string, unknown>, state: StreamState, output: string[]): void {
  const item = recordOf(object.item);
  const itemType = stringOf(item.type);
  const itemId = stringOf(item.id) || stringOf(object.item_id);
  const outputIndex = numberStringOf(object.output_index);

  if (itemType === "function_call") {
    const index = resolveToolIndexFromEvent({
      ...object,
      item_id: itemId || object.item_id,
      call_id: stringOf(item.call_id) || object.call_id,
      output_index: object.output_index,
    }, state, false);
    if (index !== undefined && state.openIndices.has(index)) {
      const name = state.toolNameByIndex.get(index) || stringOf(item.name);
      const raw = stringOf(item.arguments) || state.toolArgsByIndex.get(index) || "";
      if (raw && !state.toolArgsStreamedByIndex.has(index)) {
        const sanitized = sanitizeToolArgsJson(name, raw);
        if (sanitized) {
          output.push(formatSseEvent("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: sanitized },
          }));
        }
      }
      closeBlock(index, state, output);
    }
    cleanupToolIndex(index, itemId, stringOf(item.call_id), state);
    return;
  }

  if (itemType === "web_search_call") {
    const index = itemId && state.hostedToolIndexByItemId.has(itemId)
      ? state.hostedToolIndexByItemId.get(itemId)
      : outputIndex
        ? state.indexByKey.get(`hosted:out:${outputIndex}`)
        : undefined;
    if (index !== undefined && state.openIndices.has(index)) closeBlock(index, state, output);
    return;
  }

  for (const [key, index] of state.indexByKey.entries()) {
    if (itemId && key.startsWith(`part:${itemId}:`)) {
      closeBlock(index, state, output);
      continue;
    }
    if (outputIndex && key.startsWith(`part:out:${outputIndex}:`)) {
      closeBlock(index, state, output);
    }
  }
}

function cleanupToolIndex(index: number | undefined, itemId: string, callId: string, state: StreamState): void {
  if (itemId) state.toolIndexByItemId.delete(itemId);
  if (callId) state.toolIndexByCallId.delete(callId);
  if (index === undefined) return;
  state.toolNameByIndex.delete(index);
  state.toolArgsByIndex.delete(index);
  state.toolArgsStreamedByIndex.delete(index);
}

function assignIndexForKey(key: string, state: StreamState): number {
  const existing = state.indexByKey.get(key);
  if (existing !== undefined) return existing;
  const assigned = state.nextContentIndex++;
  state.indexByKey.set(key, assigned);
  return assigned;
}

function toolItemKey(object: Record<string, unknown>, item: Record<string, unknown>): string {
  return stringOf(item.id) ? `tool:${stringOf(item.id)}` : stringOf(object.item_id) ? `tool:${stringOf(object.item_id)}` : outputIndexKey("tool", object);
}

function outputIndexKey(prefix: string, object: Record<string, unknown>): string {
  const outputIndex = numberStringOf(object.output_index);
  return outputIndex ? `${prefix}:out:${outputIndex}` : "";
}

function indexForContentKey(object: Record<string, unknown>, state: StreamState): number | undefined {
  const key = contentPartKey(object);
  return key ? state.indexByKey.get(key) : undefined;
}

function contentPartKey(object: Record<string, unknown>): string {
  const itemId = stringOf(object.item_id);
  const outputIndex = numberStringOf(object.output_index);
  const contentIndex = numberStringOf(object.content_index);
  if (itemId && contentIndex) return `part:${itemId}:${contentIndex}`;
  if (outputIndex && contentIndex) return `part:out:${outputIndex}:${contentIndex}`;
  return "";
}

function annotationsFromObject(object: Record<string, unknown>): Record<string, unknown>[] {
  const direct = recordOf(object.annotation);
  if (direct && Object.keys(direct).length > 0) return [direct];
  const annotations = arrayOf(object.annotations) || arrayOf(recordOf(object.part).annotations) || arrayOf(recordOf(object.content_part).annotations);
  return (annotations || []).flatMap((item) => {
    const annotation = recordOf(item);
    return Object.keys(annotation).length > 0 ? [annotation] : [];
  });
}

function anthropicCitationFromResponsesAnnotation(annotation: Record<string, unknown>): Record<string, unknown> | undefined {
  const type = stringOf(annotation.type);
  if (type !== "url_citation") return undefined;
  const url = stringOf(annotation.url);
  if (!url) return undefined;
  const title = stringOf(annotation.title) || url;
  const citedText = stringOf(annotation.cited_text) || stringOf(annotation.text);
  return {
    type: "web_search_result_location",
    url,
    title,
    ...(citedText ? { cited_text: citedText } : {}),
    start_index: numberOf(annotation.start_index),
    end_index: numberOf(annotation.end_index),
  };
}

function citationKey(object: Record<string, unknown>, citation: Record<string, unknown>): string {
  return [
    contentPartKey(object),
    stringOf(citation.url),
    stringOf(citation.title),
    String(numberOf(citation.start_index) ?? ""),
    String(numberOf(citation.end_index) ?? ""),
  ].join("|");
}

function sanitizeToolArgsJson(name: string, raw: string): string {
  if (!raw) return "";
  try {
    return JSON.stringify(sanitizeAnthropicToolUseInput(name, JSON.parse(raw)));
  } catch {
    return raw;
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

function numberStringOf(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : stringOf(value);
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

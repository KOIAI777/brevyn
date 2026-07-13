import assert from "node:assert/strict";
import { OpenAiResponsesToAnthropicSseTransformer, openAiResponsesSseToAnthropicSse } from "./index";
import { parseSseEvents } from "../sse";

function event(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function convertedEvents(input: string): unknown[] {
  return parseSseEvents(openAiResponsesSseToAnthropicSse(input)).map((item) => JSON.parse(item.data));
}

const textEvents = convertedEvents([
  event("response.created", { type: "response.created", response: { id: "resp_text", model: "gpt-5.5", usage: { input_tokens: 3 } } }),
  event("response.content_part.added", { type: "response.content_part.added", part: { type: "output_text", text: "" }, output_index: 0, content_index: 0 }),
  event("response.output_text.delta", { type: "response.output_text.delta", delta: "Hel", output_index: 0, content_index: 0 }),
  event("response.output_text.delta", { type: "response.output_text.delta", delta: "lo", output_index: 0, content_index: 0 }),
  event("response.output_text.done", { type: "response.output_text.done", output_index: 0, content_index: 0 }),
  event("response.completed", { type: "response.completed", response: { status: "completed", usage: { input_tokens: 3, output_tokens: 2 } } }),
].join(""));

assert.deepEqual(textEvents.map((item) => (item as { type?: string }).type), [
  "message_start",
  "content_block_start",
  "content_block_delta",
  "content_block_delta",
  "content_block_stop",
  "message_delta",
  "message_stop",
]);
assert.equal((textEvents[0] as { message: { id: string; model: string } }).message.id, "resp_text");
assert.equal((textEvents[2] as { delta: { text: string } }).delta.text, "Hel");
assert.equal((textEvents[5] as { usage: { output_tokens: number } }).usage.output_tokens, 2);
assert.equal((textEvents[5] as { _brevynUsage?: { inputTokens?: number; outputTokens?: number } })._brevynUsage?.inputTokens, 3);
assert.equal((textEvents[5] as { _brevynUsage?: { inputTokens?: number; outputTokens?: number } })._brevynUsage?.outputTokens, 2);

const thinkingEvents = convertedEvents([
  event("response.created", { type: "response.created", response: { id: "resp_think", model: "o3" } }),
  event("response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", delta: "Think" }),
  event("response.reasoning_summary_text.done", { type: "response.reasoning_summary_text.done" }),
  event("response.content_part.added", { type: "response.content_part.added", part: { type: "output_text" }, output_index: 0, content_index: 0 }),
  event("response.output_text.delta", { type: "response.output_text.delta", delta: "Answer", output_index: 0, content_index: 0 }),
  event("response.completed", { type: "response.completed", response: { status: "completed" } }),
].join(""));

assert.equal((thinkingEvents[1] as { content_block: { type: string } }).content_block.type, "thinking");
assert.equal((thinkingEvents[2] as { delta: { thinking: string } }).delta.thinking, "Think");
assert.equal((thinkingEvents[4] as { content_block: { type: string } }).content_block.type, "text");

const readToolEvents = convertedEvents([
  event("response.created", { type: "response.created", response: { id: "resp_tool", model: "gpt-5.5" } }),
  event("response.output_item.added", { type: "response.output_item.added", item: { id: "fc_read", type: "function_call", call_id: "call_read", name: "Read" } }),
  event("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: "fc_read", delta: "{\"file_path\":\"/tmp/a.md\",\"pages\":\"\"}" }),
  event("response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: "fc_read" }),
  event("response.completed", { type: "response.completed", response: { status: "completed", usage: { input_tokens: 4, output_tokens: 5 } } }),
].join(""));

assert.equal((readToolEvents[1] as { content_block: { type: string; name: string } }).content_block.type, "tool_use");
assert.equal((readToolEvents[1] as { content_block: { name: string } }).content_block.name, "Read");
assert.match((readToolEvents[2] as { delta: { partial_json: string } }).delta.partial_json, /file_path/);
assert.doesNotMatch((readToolEvents[2] as { delta: { partial_json: string } }).delta.partial_json, /pages/);
assert.equal((readToolEvents[4] as { delta: { stop_reason: string } }).delta.stop_reason, "tool_use");

const interleavedTools = convertedEvents([
  event("response.created", { type: "response.created", response: { id: "resp_multi", model: "gpt-5.5" } }),
  event("response.output_item.added", { type: "response.output_item.added", item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "first" } }),
  event("response.output_item.added", { type: "response.output_item.added", item: { id: "fc_2", type: "function_call", call_id: "call_2", name: "second" } }),
  event("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: "fc_2", delta: "{\"b\":2}" }),
  event("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{\"a\":1}" }),
  event("response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: "fc_1" }),
  event("response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: "fc_2" }),
  event("response.completed", { type: "response.completed", response: { status: "completed" } }),
].join(""));

const toolStarts = interleavedTools.filter((item) => {
  const object = item as { type?: string; content_block?: { type?: string } };
  return object.type === "content_block_start" && object.content_block?.type === "tool_use";
});
const argDeltas = interleavedTools.filter((item) => {
  const object = item as { type?: string; delta?: { type?: string } };
  return object.type === "content_block_delta" && object.delta?.type === "input_json_delta";
});
assert.equal(toolStarts.length, 2);
assert.equal(argDeltas.length, 2);
assert.equal((argDeltas[0] as { index: number }).index, (toolStarts[1] as { index: number }).index);
assert.equal((argDeltas[1] as { index: number }).index, (toolStarts[0] as { index: number }).index);

const doneOnlyToolEvents = convertedEvents([
  event("response.created", { type: "response.created", response: { id: "resp_done_only", model: "gpt-5.5" } }),
  event("response.output_item.added", { type: "response.output_item.added", item: { id: "fc_write", type: "function_call", call_id: "call_write", name: "Write" } }),
  event("response.function_call_arguments.done", {
    type: "response.function_call_arguments.done",
    item_id: "fc_write",
    arguments: "{\"file_path\":\"/tmp/a.md\",\"content\":\"hello\"}",
  }),
  event("response.completed", { type: "response.completed", response: { status: "completed" } }),
].join(""));

const doneOnlyArg = doneOnlyToolEvents.find((item) => {
  const object = item as { type?: string; delta?: { type?: string; partial_json?: string } };
  return object.type === "content_block_delta" && object.delta?.type === "input_json_delta";
}) as { delta?: { partial_json?: string } } | undefined;
assert.equal(doneOnlyArg?.delta?.partial_json, "{\"file_path\":\"/tmp/a.md\",\"content\":\"hello\"}");

const outputItemDoneToolEvents = convertedEvents([
  event("response.created", { type: "response.created", response: { id: "resp_output_done_tool", model: "gpt-5.5" } }),
  event("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: "fc_output_done", type: "function_call", call_id: "call_output_done", name: "Edit" } }),
  event("response.output_item.done", {
    type: "response.output_item.done",
    output_index: 0,
    item: {
      id: "fc_output_done",
      type: "function_call",
      call_id: "call_output_done",
      name: "Edit",
      arguments: "{\"file_path\":\"/tmp/a.md\",\"old_string\":\"a\",\"new_string\":\"b\"}",
    },
  }),
  event("response.completed", { type: "response.completed", response: { status: "completed" } }),
].join(""));

const outputDoneArg = outputItemDoneToolEvents.find((item) => {
  const object = item as { type?: string; delta?: { type?: string; partial_json?: string } };
  return object.type === "content_block_delta" && object.delta?.type === "input_json_delta";
}) as { delta?: { partial_json?: string } } | undefined;
assert.equal(outputDoneArg?.delta?.partial_json, "{\"file_path\":\"/tmp/a.md\",\"old_string\":\"a\",\"new_string\":\"b\"}");

const hostedSearchEvents = convertedEvents([
  event("response.created", { type: "response.created", response: { id: "resp_search", model: "gpt-5.5" } }),
  event("response.output_item.added", {
    type: "response.output_item.added",
    item: { id: "ws_1", type: "web_search_call", status: "in_progress", action: { type: "search", queries: [{ query: "AI news today" }] } },
  }),
  event("response.web_search_call.searching", {
    type: "response.web_search_call.searching",
    item_id: "ws_1",
    action: { query: "AI news today" },
  }),
  event("response.web_search_call.completed", {
    type: "response.web_search_call.completed",
    item_id: "ws_1",
    action: {
      type: "search",
      query: "AI news today",
      sources: [{ url: "https://example.com/news", title: "News" }],
    },
  }),
  event("response.output_text.delta", { type: "response.output_text.delta", delta: "Found news." }),
  event("response.completed", { type: "response.completed", response: { status: "completed" } }),
].join(""));

const hostedStart = hostedSearchEvents.find((item) => {
  const object = item as { type?: string; content_block?: { type?: string } };
  return object.type === "content_block_start" && object.content_block?.type === "server_tool_use";
}) as { content_block?: { name?: string; input?: { hosted?: boolean; query?: string } }; index?: number } | undefined;
assert.equal(hostedStart?.content_block?.name, "WebSearch");
assert.equal(hostedStart?.content_block?.input?.hosted, true);
assert.equal(hostedStart?.content_block?.input?.query, "AI news today");
const hostedCompleted = hostedSearchEvents.find((item) => {
  const object = item as { type?: string; delta?: { type?: string; partial_json?: string } };
  return object.type === "content_block_delta" && object.delta?.type === "input_json_delta";
}) as { delta?: { partial_json?: string } } | undefined;
assert.match(hostedCompleted?.delta?.partial_json || "", /completed/);
assert.match(hostedCompleted?.delta?.partial_json || "", /example\.com\/news/);
assert.equal(hostedSearchEvents.some((item) => (item as { delta?: { text?: string } }).delta?.text === "Found news."), true);

const callIdOnlyToolEvents = convertedEvents([
  event("response.created", { type: "response.created", response: { id: "resp_call_id", model: "gpt-5.5" } }),
  event("response.output_item.added", { type: "response.output_item.added", output_index: 1, item: { type: "function_call", call_id: "call_only", name: "Bash" } }),
  event("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", call_id: "call_only", delta: "{\"command\":\"pwd\"}" }),
  event("response.function_call_arguments.done", { type: "response.function_call_arguments.done", call_id: "call_only" }),
  event("response.completed", { type: "response.completed", response: { status: "completed" } }),
].join(""));

const callOnlyToolStart = callIdOnlyToolEvents.find((item) => {
  const object = item as { type?: string; content_block?: { type?: string } };
  return object.type === "content_block_start" && object.content_block?.type === "tool_use";
}) as { index?: number } | undefined;
const callOnlyArg = callIdOnlyToolEvents.find((item) => {
  const object = item as { type?: string; delta?: { type?: string } };
  return object.type === "content_block_delta" && object.delta?.type === "input_json_delta";
}) as { index?: number } | undefined;
assert.equal(callOnlyArg?.index, callOnlyToolStart?.index);

const hostedSearchCitationEvents = convertedEvents([
  event("response.created", { type: "response.created", response: { id: "resp_search_cited", model: "gpt-5.5" } }),
  event("response.content_part.added", { type: "response.content_part.added", part: { type: "output_text", text: "" }, output_index: 0, content_index: 0 }),
  event("response.output_text.delta", { type: "response.output_text.delta", delta: "OpenAI announced news.", output_index: 0, content_index: 0 }),
  event("response.output_text.annotation.added", {
    type: "response.output_text.annotation.added",
    output_index: 0,
    content_index: 0,
    annotation_index: 0,
    annotation: {
      type: "url_citation",
      url: "https://openai.com/news",
      title: "OpenAI News",
      start_index: 0,
      end_index: 6,
    },
  }),
  event("response.output_text.done", { type: "response.output_text.done", output_index: 0, content_index: 0 }),
  event("response.completed", { type: "response.completed", response: { status: "completed" } }),
].join(""));

const citationDelta = hostedSearchCitationEvents.find((item) => {
  const object = item as { type?: string; delta?: { type?: string } };
  return object.type === "content_block_delta" && object.delta?.type === "citations_delta";
}) as { delta?: { citation?: { url?: string; title?: string; type?: string } } } | undefined;
assert.equal(citationDelta?.delta?.citation?.type, "web_search_result_location");
assert.equal(citationDelta?.delta?.citation?.url, "https://openai.com/news");
assert.equal(citationDelta?.delta?.citation?.title, "OpenAI News");

const dangling = convertedEvents([
  event("response.created", { type: "response.created", response: { id: "resp_dangling", model: "gpt-5.5" } }),
  event("response.output_text.delta", { type: "response.output_text.delta", delta: "No explicit done" }),
  event("response.completed", { type: "response.completed", response: { status: "completed" } }),
].join(""));

assert.deepEqual(dangling.map((item) => (item as { type?: string }).type), [
  "message_start",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "message_delta",
  "message_stop",
]);

const incompleteEvents = convertedEvents([
  event("response.created", { type: "response.created", response: { id: "resp_incomplete", model: "gpt-5.5" } }),
  event("response.output_text.delta", { type: "response.output_text.delta", delta: "Partial" }),
  event("response.incomplete", {
    type: "response.incomplete",
    response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 7, output_tokens: 8 } },
  }),
].join(""));

assert.deepEqual(incompleteEvents.map((item) => (item as { type?: string }).type), [
  "message_start",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "message_delta",
  "message_stop",
]);
assert.equal((incompleteEvents[4] as { delta: { stop_reason: string }; usage: { output_tokens: number } }).delta.stop_reason, "max_tokens");
assert.equal((incompleteEvents[4] as { usage: { output_tokens: number } }).usage.output_tokens, 8);

const failedEvents = parseSseEvents(openAiResponsesSseToAnthropicSse([
  event("response.created", { type: "response.created", response: { id: "resp_failed", model: "gpt-5.5" } }),
  event("response.failed", {
    type: "response.failed",
    response: { status: "failed", error: { code: "bad_request", message: "Hosted tool failed" } },
  }),
].join(""))).map((item) => ({ event: item.event, data: JSON.parse(item.data) }));

assert.equal(failedEvents.at(-1)?.event, "error");
assert.equal(failedEvents.at(-1)?.data.error.message, "Hosted tool failed");

const incremental = new OpenAiResponsesToAnthropicSseTransformer();
const firstChunk = incremental.push([
  "event: response.created\n",
  "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_incremental\",\"model\":\"gpt-5.5\"}}\n\n",
  "event: response.output_text.delta\n",
].join(""));
const secondChunk = incremental.push([
  "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Live\"}\n\n",
  "event: response.completed\n",
  "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
].join(""));
const incrementalEvents = parseSseEvents(firstChunk + secondChunk + incremental.flush()).map((item) => JSON.parse(item.data));
assert.equal((incrementalEvents[0] as { type?: string }).type, "message_start");
assert.equal((incrementalEvents[2] as { delta?: { text?: string } }).delta?.text, "Live");
assert.equal((incrementalEvents.at(-1) as { type?: string }).type, "message_stop");

console.log("openai-responses-anthropic-stream tests passed");

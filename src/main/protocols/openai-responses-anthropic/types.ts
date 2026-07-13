import type { BrevynUsageMetadata } from "../../../types/domain";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface AnthropicMessagesRequest {
  model?: string;
  system?: string | Array<{ type?: string; text?: string }>;
  messages?: AnthropicMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: unknown;
  [key: string]: unknown;
}

export interface AnthropicMessage {
  role?: "user" | "assistant" | string;
  content?: string | AnthropicContentBlock[];
  [key: string]: unknown;
}

export type AnthropicContentBlock =
  | { type: "text"; text?: string; [key: string]: unknown }
  | { type: "image"; source?: { media_type?: string; data?: string }; [key: string]: unknown }
  | { type: "tool_use"; id?: string; name?: string; input?: unknown; [key: string]: unknown }
  | { type: "tool_result"; tool_use_id?: string; content?: unknown; [key: string]: unknown }
  | { type: "thinking"; thinking?: string; [key: string]: unknown }
  | { type?: string; [key: string]: unknown };

export interface AnthropicTool {
  name?: string;
  description?: string;
  input_schema?: unknown;
  type?: string;
  [key: string]: unknown;
}

export interface AnthropicMessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicResponseContentBlock[];
  model: string;
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | null;
  stop_sequence: null;
  usage: AnthropicUsage;
  _brevynUsage?: BrevynUsageMetadata;
}

export type AnthropicResponseContentBlock =
  | { type: "text"; text: string; citations?: Record<string, unknown>[] }
  | { type: "thinking"; thinking: string }
  | { type: "server_tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface OpenAiResponsesRequest {
  model?: string;
  instructions?: string;
  input?: unknown[];
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  [key: string]: unknown;
}

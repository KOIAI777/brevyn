import type { AnthropicMessagesResponse, AnthropicUsage } from "./types";
import { brevynUsageFromResponsesUsage } from "../../../shared/agent-usage";
import type { BrevynUsageMetadata } from "../../../types/domain";

export function buildAnthropicUsageFromResponses(usage: unknown): AnthropicUsage {
  const object = recordOf(usage);
  const totalInputTokens = numberOf(object.input_tokens) ?? numberOf(object.prompt_tokens) ?? 0;
  const inputDetails = recordOf(object.input_tokens_details);
  const promptDetails = recordOf(object.prompt_tokens_details);
  const cachedFromDetails = numberOf(inputDetails.cached_tokens) ?? numberOf(promptDetails.cached_tokens);
  const result: AnthropicUsage = {
    input_tokens: cachedFromDetails !== undefined ? Math.max(0, totalInputTokens - cachedFromDetails) : totalInputTokens,
    output_tokens: numberOf(object.output_tokens) ?? numberOf(object.completion_tokens) ?? 0,
  };

  if (cachedFromDetails !== undefined) result.cache_read_input_tokens = cachedFromDetails;

  const cacheRead = numberOf(object.cache_read_input_tokens);
  if (cacheRead !== undefined) result.cache_read_input_tokens = cacheRead;

  const cacheCreation = numberOf(object.cache_creation_input_tokens);
  if (cacheCreation !== undefined) result.cache_creation_input_tokens = cacheCreation;

  return result;
}

export function buildBrevynUsageFromResponses(usage: unknown, modelId?: string): BrevynUsageMetadata | undefined {
  return brevynUsageFromResponsesUsage(usage, {
    providerProtocol: "openai_responses",
    modelId,
  });
}

export function mapResponsesStopReason(
  status: string,
  hasToolUse: boolean,
  incompleteReason?: string,
): AnthropicMessagesResponse["stop_reason"] {
  if (status === "completed" && hasToolUse) return "tool_use";
  if (status === "completed") return "end_turn";
  if (status === "incomplete" && (!incompleteReason || incompleteReason === "max_output_tokens" || incompleteReason === "max_tokens")) {
    return "max_tokens";
  }
  if (status === "incomplete") return "end_turn";
  return "end_turn";
}

export function responseErrorMessage(object: Record<string, unknown>): string {
  const response = responseObject(object);
  const responseError = recordOf(response.error);
  const rootError = recordOf(object.error);
  const error = Object.keys(responseError).length > 0 ? responseError : rootError;
  return stringOf(error.message) || stringOf(error.code) || stringOf(response.status_details) || "OpenAI Responses request failed.";
}

export function httpErrorMessage(status: number, upstreamText: string): string {
  return upstreamText || `OpenAI Responses provider failed with HTTP ${status}.`;
}

export function responseObject(object: Record<string, unknown>): Record<string, unknown> {
  const response = recordOf(object.response);
  return Object.keys(response).length > 0 ? response : object;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

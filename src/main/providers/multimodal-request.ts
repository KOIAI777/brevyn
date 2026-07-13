import type { ModelProviderConfig } from "../../types/domain";
import { normalizeBaseUrl } from "./url-utils";

export type MultimodalInput =
  | { type: "image"; mediaType: string; data: string }
  | { type: "document"; mediaType: string; data: string; filename: string };

export function multimodalEndpoint(provider: ModelProviderConfig): string {
  const baseUrl = normalizeBaseUrl(provider.baseUrl)
    .replace(/\/messages$/, "")
    .replace(/\/responses$/, "")
    .replace(/\/chat\/completions$/, "");
  if (provider.protocol === "openai_responses") return `${baseUrl}/responses`;
  if (provider.protocol === "openai_compatible") return `${baseUrl}/chat/completions`;
  return `${baseUrl}/messages`;
}

export function multimodalHeaders(provider: ModelProviderConfig, apiKey: string): Record<string, string> {
  if (provider.protocol === "openai_responses" || provider.protocol === "openai_compatible") {
    return provider.authMode === "api_key"
      ? { "x-api-key": apiKey, "content-type": "application/json" }
      : { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
  }
  const headers: Record<string, string> = {
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
  if (provider.authMode === "bearer") headers.Authorization = `Bearer ${apiKey}`;
  else {
    headers["x-api-key"] = apiKey;
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

export function multimodalRequestBody(provider: ModelProviderConfig, input: MultimodalInput, prompt: string, maxTokens = 4096): unknown {
  if (provider.protocol === "openai_responses") {
    return {
      model: provider.selectedModel,
      max_output_tokens: maxTokens,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            openAiResponsesInput(input),
          ],
        },
      ],
    };
  }
  if (provider.protocol === "openai_compatible") {
    if (input.type !== "image") {
      throw new Error("OpenAI-compatible chat OCR only supports image inputs in this client.");
    }
    return {
      model: provider.selectedModel,
      max_tokens: maxTokens,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl(input) } },
          ],
        },
      ],
    };
  }
  return {
    model: provider.selectedModel,
    max_tokens: maxTokens,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          anthropicInput(input),
          { type: "text", text: prompt },
        ],
      },
    ],
  };
}

export function extractMultimodalText(provider: ModelProviderConfig, message: unknown): string {
  if (provider.protocol === "openai_responses") return extractOpenAiResponsesText(message);
  if (provider.protocol === "openai_compatible") return extractOpenAiChatCompletionsText(message);
  return extractAnthropicText(message);
}

function openAiResponsesInput(input: MultimodalInput): unknown {
  if (input.type === "image") return { type: "input_image", image_url: dataUrl(input) };
  return { type: "input_file", filename: input.filename, file_data: dataUrl(input) };
}

function anthropicInput(input: MultimodalInput): unknown {
  if (input.type === "image") {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: input.mediaType,
        data: input.data,
      },
    };
  }
  return {
    type: "document",
    source: {
      type: "base64",
      media_type: input.mediaType,
      data: input.data,
    },
  };
}

function dataUrl(input: MultimodalInput): string {
  return `data:${input.mediaType};base64,${input.data}`;
}

function extractOpenAiChatCompletionsText(message: unknown): string {
  const choices = objectValue(message).choices;
  if (!Array.isArray(choices)) return "";
  return choices
    .flatMap((choice) => {
      const content = objectValue(objectValue(choice).message).content;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return [];
      return content.flatMap((part) => {
        const block = objectValue(part);
        return block.type === "text" ? stringValue(block.text) : [];
      });
    })
    .join("\n")
    .trim();
}

function extractAnthropicText(message: unknown): string {
  const content = objectValue(message).content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((item) => {
      const block = objectValue(item);
      return block.type === "text" ? stringValue(block.text) : [];
    })
    .join("\n")
    .trim();
}

function extractOpenAiResponsesText(message: unknown): string {
  const outputText = stringValue(objectValue(message).output_text);
  if (outputText) return outputText;
  const output = objectValue(message).output;
  if (!Array.isArray(output)) return "";
  return output
    .flatMap((item) => {
      const content = objectValue(item).content;
      if (!Array.isArray(content)) return [];
      return content.flatMap((part) => {
        const block = objectValue(part);
        return block.type === "output_text" || block.type === "text" ? stringValue(block.text) : [];
      });
    })
    .join("\n")
    .trim();
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value).trim();
}

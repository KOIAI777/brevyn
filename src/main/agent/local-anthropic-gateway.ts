import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ModelProviderConfig } from "../../types/domain";
import {
  anthropicToOpenAiResponses,
  httpErrorMessage,
  OpenAiResponsesToAnthropicSseTransformer,
  openAiResponsesToAnthropic,
  type AnthropicMessagesRequest,
  openAiResponsesSseToAnthropicSse,
} from "../protocols/openai-responses-anthropic";
import { parseSseEvents } from "../protocols/sse";
import { normalizeBaseUrl } from "../providers/url-utils";

export interface LocalAnthropicGatewaySession {
  provider: Pick<ModelProviderConfig, "id" | "name" | "baseUrl" | "selectedModel">;
  apiKey: string;
  signal?: AbortSignal;
}

export interface LocalAnthropicGatewayRegistration {
  token: string;
  baseUrl: string;
}

interface LocalAnthropicGatewayOptions {
  host?: string;
  fetchImpl?: typeof fetch;
}

const MAX_BODY_BYTES = 16 * 1024 * 1024;

export class LocalAnthropicGateway {
  private readonly host: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sessions = new Map<string, LocalAnthropicGatewaySession>();
  private server?: Server;
  private port?: number;
  private startPromise?: Promise<void>;

  constructor(options: LocalAnthropicGatewayOptions = {}) {
    this.host = options.host || "127.0.0.1";
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async start(): Promise<string> {
    if (this.port !== undefined) return this.baseUrl();
    if (this.startPromise) {
      await this.startPromise;
      return this.baseUrl();
    }

    this.server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    this.startPromise = new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server?.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server?.off("error", onError);
        const address = this.server?.address();
        if (!address || typeof address === "string") {
          reject(new Error("Local Anthropic gateway did not bind to a TCP port."));
          return;
        }
        this.port = address.port;
        resolve();
      };
      this.server?.once("error", onError);
      this.server?.once("listening", onListening);
      this.server?.listen(0, this.host);
    }).finally(() => {
      this.startPromise = undefined;
    });

    await this.startPromise;
    return this.baseUrl();
  }

  async stop(): Promise<void> {
    if (this.startPromise) {
      await this.startPromise.catch(() => undefined);
    }
    this.sessions.clear();
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error && !isServerNotRunningError(error) ? reject(error) : resolve());
    });
  }

  registerSession(session: LocalAnthropicGatewaySession): LocalAnthropicGatewayRegistration {
    if (this.port === undefined) throw new Error("Local Anthropic gateway must be started before registering a session.");
    const token = `brevyn-gw-${randomBytes(18).toString("hex")}`;
    this.sessions.set(token, session);
    return { token, baseUrl: this.baseUrl() };
  }

  unregisterSession(token: string): void {
    this.sessions.delete(token);
  }

  private baseUrl(): string {
    if (this.port === undefined) throw new Error("Local Anthropic gateway is not running.");
    return `http://${this.host}:${this.port}`;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method !== "POST" || !isMessagesPath(request.url || "")) {
        writeJson(response, 404, { type: "error", error: { type: "not_found_error", message: "Not found." } });
        return;
      }

      const token = authTokenFromRequest(request);
      const session = token ? this.sessions.get(token) : undefined;
      if (!token || !session) {
        writeJson(response, 401, { type: "error", error: { type: "authentication_error", message: "Invalid local gateway token." } });
        return;
      }

      const rawBody = await readRequestBody(request);
      const body = JSON.parse(rawBody) as AnthropicMessagesRequest;
      if (!body.model && session.provider.selectedModel) body.model = session.provider.selectedModel;

      const upstreamRequest = anthropicToOpenAiResponses(body);
      const upstreamResponse = await this.fetchImpl(openAiResponsesUrl(session.provider.baseUrl), {
        method: "POST",
        headers: {
          "authorization": `Bearer ${session.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(upstreamRequest),
        signal: session.signal,
      });

      if (!upstreamResponse.ok) {
        const upstreamText = await upstreamResponse.text();
        writeJson(response, upstreamResponse.status, {
          type: "error",
          error: {
            type: "api_error",
            message: httpErrorMessage(upstreamResponse.status, upstreamText),
          },
        });
        return;
      }

      if (body.stream === true) {
        if (upstreamResponse.body) {
          await writeConvertedSseStream(response, upstreamResponse.body);
        } else {
          const converted = openAiResponsesSseToAnthropicSse(await upstreamResponse.text());
          writeText(response, 200, converted, "text/event-stream; charset=utf-8");
        }
        return;
      }

      const upstreamText = await upstreamResponse.text();
      const upstreamPayload = responsesPayloadFromText(upstreamText, upstreamResponse.headers.get("content-type") || "");
      const converted = openAiResponsesToAnthropic(upstreamPayload);
      writeJson(response, 200, converted);
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      writeJson(response, aborted ? 499 : 500, {
        type: "error",
        error: {
          type: aborted ? "request_aborted" : "api_error",
          message: errorMessage(error),
        },
      });
    }
  }
}

function isMessagesPath(url: string): boolean {
  const pathname = new URL(url, "http://127.0.0.1").pathname.replace(/\/+$/, "");
  return pathname === "/messages" || pathname === "/v1/messages";
}

function authTokenFromRequest(request: IncomingMessage): string {
  const apiKey = headerValue(request, "x-api-key");
  if (apiKey) return apiKey;
  const authorization = headerValue(request, "authorization");
  return authorization.replace(/^Bearer\s+/i, "").trim();
}

function headerValue(request: IncomingMessage, name: string): string {
  const value = request.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] || "";
  return typeof value === "string" ? value : "";
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function writeConvertedSseStream(response: ServerResponse, body: ReadableStream<Uint8Array>): Promise<void> {
  if (!safeWriteHead(response, 200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    "connection": "keep-alive",
  })) return;

  const transformer = new OpenAiResponsesToAnthropicSseTransformer();
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const converted = transformer.push(value);
      if (converted) response.write(converted);
    }
    const tail = transformer.flush();
    if (tail) response.write(tail);
  } catch (error) {
    writeSseError(response, errorMessage(error));
  } finally {
    reader.releaseLock();
    safeEnd(response);
  }
}

function openAiResponsesUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl)
    .replace(/\/responses$/, "")
    .replace(/\/chat\/completions$/, "");
  return `${normalized || "https://api.openai.com/v1"}/responses`;
}

function responsesPayloadFromText(body: string, contentType: string): unknown {
  if (contentType.includes("text/event-stream") || bodyLooksLikeSse(body)) {
    return responsesSseToResponseValue(body);
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    if (bodyLooksLikeSse(body)) return responsesSseToResponseValue(body);
    throw error;
  }
}

function responsesSseToResponseValue(body: string): unknown {
  let completedResponse: Record<string, unknown> | undefined;
  const outputItems: unknown[] = [];

  for (const event of parseSseEvents(body.trimStart().replace(/^\uFEFF/, ""))) {
    if (event.data.trim() === "[DONE]") continue;
    let data: unknown;
    try {
      data = JSON.parse(event.data);
    } catch {
      continue;
    }

    const object = recordOf(data);
    const eventName = event.event || stringOf(object.type);
    if (eventName === "response.output_item.done") {
      const item = object.item;
      if (item !== undefined) outputItems.push(item);
      continue;
    }
    if (eventName === "response.completed") {
      completedResponse = recordOf(object.response);
      if (Object.keys(completedResponse).length === 0) completedResponse = object;
      continue;
    }
    if (eventName === "response.failed") {
      throw new Error(responseFailedMessage(object));
    }
  }

  if (!completedResponse) throw new Error("No response.completed event in upstream SSE.");
  if (outputItems.length > 0) completedResponse = { ...completedResponse, output: outputItems };
  return completedResponse;
}

function bodyLooksLikeSse(body: string): boolean {
  const trimmed = body.trimStart().replace(/^\uFEFF/, "").trimStart();
  return ["data:", "event:", "id:", "retry:", ":"].some((prefix) => trimmed.startsWith(prefix));
}

function responseFailedMessage(object: Record<string, unknown>): string {
  const response = recordOf(object.response);
  const responseError = recordOf(response.error);
  return stringOf(responseError.message) || stringOf(recordOf(object.error).message) || "response.failed event received";
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  writeText(response, statusCode, JSON.stringify(payload), "application/json; charset=utf-8");
}

function writeText(response: ServerResponse, statusCode: number, payload: string, contentType: string): void {
  if (!safeWriteHead(response, statusCode, {
    "content-type": contentType,
    "cache-control": "no-cache",
  })) {
    safeEnd(response);
    return;
  }
  safeEnd(response, payload);
}

function safeWriteHead(response: ServerResponse, statusCode: number, headers: Record<string, string>): boolean {
  if (response.destroyed || response.writableEnded || response.headersSent) return false;
  response.writeHead(statusCode, headers);
  return true;
}

function safeEnd(response: ServerResponse, payload?: string): void {
  if (response.destroyed || response.writableEnded) return;
  response.end(payload);
}

function writeSseError(response: ServerResponse, message: string): void {
  if (response.destroyed || response.writableEnded) return;
  try {
    response.write(`event: error\ndata: ${JSON.stringify({
      type: "error",
      error: {
        type: "api_error",
        message,
      },
    })}\n\n`);
  } catch {
    response.destroy();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isServerNotRunningError(error: Error): boolean {
  return (error as Error & { code?: string }).code === "ERR_SERVER_NOT_RUNNING";
}

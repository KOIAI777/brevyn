import assert from "node:assert/strict";
import { LocalAnthropicGateway } from "./local-anthropic-gateway";
import type { ModelProviderConfig } from "../../types/domain";

function responsesSse(id: string, text: string): string {
  return [
    "event: response.output_item.done\n",
    `data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":${JSON.stringify(text)}}]}}\n\n`,
    "event: response.completed\n",
    `data: {"type":"response.completed","response":{"id":${JSON.stringify(id)},"model":"gpt-test","status":"completed","usage":{"input_tokens":2,"output_tokens":3}}}\n\n`,
  ].join("");
}

async function main(): Promise<void> {
  const provider = {
    id: "provider_test",
    name: "Responses Test",
    baseUrl: "https://api.example.com/v1",
    selectedModel: "gpt-test",
  } as Pick<ModelProviderConfig, "id" | "name" | "baseUrl" | "selectedModel">;

  let capturedUrl = "";
  let capturedBody: unknown;
  let capturedAuth = "";

  const gateway = new LocalAnthropicGateway({
    fetchImpl: async (input, init) => {
      capturedUrl = String(input);
      capturedAuth = String((init?.headers as Record<string, string>).authorization || "");
      capturedBody = JSON.parse(String(init?.body || "{}"));

      const body = capturedBody as { input?: unknown; stream?: boolean };
      if (JSON.stringify(body.input || "").includes("Fail upstream")) {
        return new Response("provider raw error", { status: 429 });
      }
      if (JSON.stringify(body.input || "").includes("SSE content type fallback")) {
        return new Response(responsesSse("resp_sse_content_type", "Aggregated from SSE content type"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (JSON.stringify(body.input || "").includes("SSE body fallback")) {
        return new Response(responsesSse("resp_sse_body", "Aggregated from SSE body"), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (body.stream) {
        if (JSON.stringify(body.input || "").includes("Broken stream")) {
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode([
                "event: response.created\n",
                "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_broken\",\"model\":\"gpt-test\"}}\n\n",
              ].join("")));
              controller.error(new Error("provider stream exploded"));
            },
          }), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response([
          "event: response.created\n",
          "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_stream\",\"model\":\"gpt-test\"}}\n\n",
          "event: response.output_text.delta\n",
          "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hi\"}\n\n",
          "event: response.completed\n",
          "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n",
        ].join(""), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }

      return Response.json({
        id: "resp_json",
        model: "gpt-test",
        status: "completed",
        output: [
          { type: "message", content: [{ type: "output_text", text: "Hello from upstream" }] },
        ],
        usage: { input_tokens: 5, output_tokens: 7 },
      });
    },
  });

  try {
    const baseUrl = await gateway.start();
    const registration = gateway.registerSession({
      provider,
      apiKey: "sk-test",
    });

    const jsonResponse = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": registration.token,
      },
      body: JSON.stringify({
        system: "You are helpful.",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 12,
      }),
    });

    assert.equal(jsonResponse.status, 200);
    assert.equal(capturedUrl, "https://api.example.com/v1/responses");
    assert.equal(capturedAuth, "Bearer sk-test");
    assert.deepEqual(capturedBody, {
      model: "gpt-test",
      instructions: "You are helpful.",
      input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
      max_output_tokens: 12,
    });

    const jsonPayload = await jsonResponse.json();
    assert.deepEqual({
      ...jsonPayload,
      _brevynUsage: undefined,
    }, {
      id: "resp_json",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hello from upstream" }],
      model: "gpt-test",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 7 },
      _brevynUsage: undefined,
    });
    assert.equal(jsonPayload._brevynUsage?.inputTokens, 5);
    assert.equal(jsonPayload._brevynUsage?.outputTokens, 7);

    const sseContentTypeFallback = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": registration.token,
      },
      body: JSON.stringify({
        model: "gpt-test",
        messages: [{ role: "user", content: "SSE content type fallback" }],
      }),
    });
    assert.equal(sseContentTypeFallback.status, 200);
    assert.match(sseContentTypeFallback.headers.get("content-type") || "", /application\/json/);
    const sseContentTypePayload = await sseContentTypeFallback.json();
    assert.equal(sseContentTypePayload.id, "resp_sse_content_type");
    assert.deepEqual(sseContentTypePayload.content, [{ type: "text", text: "Aggregated from SSE content type" }]);
    assert.equal(sseContentTypePayload.usage.input_tokens, 2);
    assert.equal(sseContentTypePayload.usage.output_tokens, 3);

    const sseBodyFallback = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": registration.token,
      },
      body: JSON.stringify({
        model: "gpt-test",
        messages: [{ role: "user", content: "SSE body fallback" }],
      }),
    });
    assert.equal(sseBodyFallback.status, 200);
    assert.match(sseBodyFallback.headers.get("content-type") || "", /application\/json/);
    const sseBodyPayload = await sseBodyFallback.json();
    assert.equal(sseBodyPayload.id, "resp_sse_body");
    assert.deepEqual(sseBodyPayload.content, [{ type: "text", text: "Aggregated from SSE body" }]);

    const streamResponse = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${registration.token}`,
      },
      body: JSON.stringify({
        model: "gpt-test",
        stream: true,
        messages: [{ role: "user", content: "Stream please" }],
      }),
    });

    assert.equal(streamResponse.status, 200);
    assert.match(streamResponse.headers.get("content-type") || "", /text\/event-stream/);
    const streamText = await streamResponse.text();
    assert.match(streamText, /event: message_start/);
    assert.match(streamText, /"type":"text_delta"/);
    assert.match(streamText, /"text":"Hi"/);
    assert.match(streamText, /event: message_stop/);

    const brokenStreamResponse = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${registration.token}`,
      },
      body: JSON.stringify({
        model: "gpt-test",
        stream: true,
        messages: [{ role: "user", content: "Broken stream" }],
      }),
    });

    assert.equal(brokenStreamResponse.status, 200);
    const brokenStreamText = await brokenStreamResponse.text();
    assert.match(brokenStreamText, /event: error/);
    assert.match(brokenStreamText, /provider stream exploded/);

    const errorResponse = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": registration.token,
      },
      body: JSON.stringify({
        model: "gpt-test",
        messages: [{ role: "user", content: "Fail upstream" }],
      }),
    });
    assert.equal(errorResponse.status, 429);
    const errorPayload = await errorResponse.json();
    assert.equal(errorPayload.error.message, "provider raw error");

    gateway.unregisterSession(registration.token);
    const unauthorized = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": registration.token,
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "Nope" }] }),
    });

    assert.equal(unauthorized.status, 401);
  } finally {
    await gateway.stop();
  }

  console.log("local-anthropic-gateway tests passed");
}

void main();

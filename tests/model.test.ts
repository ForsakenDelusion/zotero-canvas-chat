import assert from "node:assert/strict";
import test from "node:test";
import { modelEndpoint, modelStream } from "../src/model.ts";

const input = {
  system: "Read the paper.",
  messages: [{ role: "user" as const, text: "Explain the figure." }],
  signal: new AbortController().signal,
};

const settings = { provider: "compatible" as const, endpoint: "http://127.0.0.1:17362/v1", model: "fixture" };

function response(chunks: Uint8Array[]) {
  return new Response(new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

test("a streamed response decodes UTF-8 even when a character spans chunks", async () => {
  const body = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"图"}}]}\r\n\r\ndata: [DONE]\r\n\r\n');
  const split = body.findIndex((byte) => byte > 127) + 1;
  const tokens: string[] = [];
  for await (const token of modelStream(settings, "", input, async () =>
    response([body.slice(0, split), body.slice(split)]))) tokens.push(token);
  assert.deepEqual(tokens, ["图"]);
});

test("interrupted streams report a retryable error", async () => {
  const body = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"unfinished"}}]}\n\n');
  const tokens: string[] = [];
  await assert.rejects(async () => {
    for await (const token of modelStream(settings, "", input, async () => response([body]))) tokens.push(token);
  }, /提前中断/);
  assert.deepEqual(tokens, ["unfinished"]);
});

test("Anthropic image inputs use native content blocks", async () => {
  const provider = { ...settings, provider: "anthropic" as const, endpoint: "https://api.anthropic.com/v1" };
  const body = new TextEncoder().encode('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Figure"}}\n\ndata: {"type":"message_stop"}\n\n');
  const messages = [{ ...input.messages[0], images: ["data:image/png;base64,dGVzdA=="] }];
  const fake: typeof fetch = async (url, options) => {
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    assert.equal((options?.headers as Record<string, string>)["x-api-key"], "fixture-key");
    assert.deepEqual(JSON.parse(String(options?.body)).messages[0].content[1],
      { type: "image", source: { type: "base64", media_type: "image/png", data: "dGVzdA==" } });
    return response([body]);
  };
  const tokens: string[] = [];
  for await (const token of modelStream(provider, "fixture-key", { ...input, messages }, fake)) tokens.push(token);
  assert.deepEqual(tokens, ["Figure"]);
});

test("Ollama's loopback address resolves to its compatible API", () => {
  assert.equal(modelEndpoint({ ...settings, provider: "ollama", endpoint: "http://127.0.0.1:11434" }),
    "http://127.0.0.1:11434/v1/chat/completions");
  assert.throws(() => modelEndpoint({ ...settings, endpoint: "http://example.com" }), /HTTPS/);
});

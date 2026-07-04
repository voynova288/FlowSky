import test from "node:test";
import assert from "node:assert/strict";
import { ReadableStream } from "node:stream/web";
import { OpenAICompatibleProvider, sanitizeForLog } from "../../packages/agent-gateway/src/providers/OpenAICompatibleProvider.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("openai-compatible provider sends chat completions request", async () => {
  const calls: any[] = [];
  const provider = new OpenAICompatibleProvider({
    providerName: "OpenAI",
    apiKey: "test-openai-key",
    baseUrl: "https://example.test/v1/",
    fetchFn: async (url, init) => {
      calls.push({ url, headers: init?.headers, body: JSON.parse(String(init?.body)) });
      return jsonResponse({ choices: [{ message: { content: "hello" } }], usage: { prompt_tokens: 1, completion_tokens: 2 } });
    },
  });
  const result = await provider.complete({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] });
  assert.equal(result.text, "hello");
  assert.equal(result.usage.completion_tokens, 2);
  assert.equal(calls[0].url, "https://example.test/v1/chat/completions");
  assert.equal(calls[0].headers.authorization, "Bearer test-openai-key");
  assert.equal(calls[0].body.stream, false);
});

test("openai-compatible provider streams text and usage", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"lo"}}],"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n'));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  const provider = new OpenAICompatibleProvider({ apiKey: "test-openai-key", baseUrl: "https://example.test/v1", fetchFn: async () => new Response(body, { status: 200 }) });
  let text = "";
  let sawUsage = false;
  for await (const chunk of provider.stream({ model: "gpt-4o-mini", stream: true, messages: [{ role: "user", content: "hi" }] })) {
    text += chunk.delta ?? "";
    if (chunk.usage) sawUsage = true;
  }
  assert.equal(text, "hello");
  assert.equal(sawUsage, true);
});

test("openai-compatible stream assembles fragmented tool calls", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_current_time","arguments":"{\\\"timezone\\\":"}}]}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\\"Asia/Tokyo\\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n'));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  const provider = new OpenAICompatibleProvider({ apiKey: "test-openai-key", baseUrl: "https://example.test/v1", fetchFn: async () => new Response(body, { status: 200 }) });
  const chunks = [];
  for await (const chunk of provider.stream({ model: "gpt-4o-mini", stream: true, messages: [{ role: "user", content: "time" }] })) chunks.push(chunk);
  const toolChunk = chunks.find((chunk) => chunk.tool_calls?.length);
  assert.ok(toolChunk);
  assert.deepEqual(toolChunk!.tool_calls![0], {
    id: "call_1",
    type: "function",
    function: { name: "get_current_time", arguments: '{"timezone":"Asia/Tokyo"}' },
  });
});

test("openai-compatible provider redacts keys in errors", async () => {
  assert.throws(() => new OpenAICompatibleProvider({ apiKey: "", baseUrl: "https://example.test/v1" }), /missing_provider_key/);
  const key = "sk-" + "liveSecretToken_1234567890";
  const redacted = sanitizeForLog("bad " + key, key);
  assert.equal(redacted.includes("liveSecretToken"), false);
});

import { createDefaultProvider, resolveProviderConfig } from "../../packages/agent-gateway/src/index.ts";

test("default provider factory selects openai with mocked fetch", async () => {
  const calls: any[] = [];
  const provider = createDefaultProvider({
    providerName: "openai",
    apiKey: "factory-openai-key",
    baseUrl: "https://openai.example/v1",
    fetchFn: async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return jsonResponse({ choices: [{ message: { content: "factory ok" } }], usage: {} });
    },
  });
  const result = await provider.complete({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] });
  assert.equal(result.text, "factory ok");
  assert.equal(calls[0].url, "https://openai.example/v1/chat/completions");
});

test("provider config resolves deepseek default and openai override", () => {
  assert.equal(resolveProviderConfig({ apiKey: "deepseek-key" }).providerName, "deepseek");
  const openai = resolveProviderConfig({ providerName: "openai", apiKey: "openai-key", baseUrl: "https://openai.example/v1/" });
  assert.equal(openai.providerName, "openai");
  assert.equal(openai.apiKey, "openai-key");
  assert.equal(openai.baseUrl, "https://openai.example/v1");
});

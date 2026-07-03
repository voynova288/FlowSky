import test from "node:test";
import assert from "node:assert/strict";
import { ReadableStream } from "node:stream/web";
import { modelConfigForMode } from "../../packages/agent-gateway/src/index.ts";
import { DeepSeekProvider, sanitizeForLog } from "../../packages/agent-gateway/src/providers/DeepSeekProvider.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("test_deepseek_nonstream_success", async () => {
  const calls: any[] = [];
  const provider = new DeepSeekProvider({
    apiKey: "test-secret",
    fetchFn: async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return jsonResponse({ choices: [{ message: { content: "你好" } }], usage: { prompt_tokens: 1, completion_tokens: 2 } });
    },
  });
  const result = await provider.complete({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] });
  assert.equal(result.text, "你好");
  assert.equal(result.usage.completion_tokens, 2);
  assert.equal(calls[0].stream, false);
});

test("test_deepseek_stream_success", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"辛苦"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"啦"}}],"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n'));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  const provider = new DeepSeekProvider({ apiKey: "test-secret", fetchFn: async () => new Response(body, { status: 200 }) });
  let text = "";
  let sawUsage = false;
  for await (const chunk of provider.stream({ model: "deepseek-v4-flash", stream: true, messages: [{ role: "user", content: "hi" }] })) {
    text += chunk.delta ?? "";
    if (chunk.usage) sawUsage = true;
  }
  assert.equal(text, "辛苦啦");
  assert.equal(sawUsage, true);
});

test("test_deepseek_json_output_valid", async () => {
  let payload: any;
  const provider = new DeepSeekProvider({
    apiKey: "test-secret",
    fetchFn: async (_url, init) => {
      payload = JSON.parse(String(init?.body));
      return jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }], usage: {} });
    },
  });
  await provider.complete({ model: "deepseek-v4-flash", response_format: { type: "json_object" }, messages: [{ role: "user", content: "json" }] });
  assert.deepEqual(payload.response_format, { type: "json_object" });
});

test("test_thinking_disabled_for_normal_chat", () => {
  assert.deepEqual(modelConfigForMode("girlfriend_chat").thinking, { type: "disabled" });
});

test("test_api_key_not_logged", () => {
  const redacted = sanitizeForLog("bad liveSecretToken_1234567890", "liveSecretToken_1234567890");
  assert.equal(redacted.includes("liveSecretToken"), false);
});

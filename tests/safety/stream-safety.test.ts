import test from "node:test";
import assert from "node:assert/strict";
import type { LLMCompleteRequest, LLMProvider, LLMResponse, LLMStreamChunk, LLMStreamRequest } from "../../packages/agent-gateway/src/index.ts";
import { AgentGateway } from "../../packages/agent-gateway/src/index.ts";

class UnsafeStreamProvider implements LLMProvider {
  async complete(_request: LLMCompleteRequest): Promise<LLMResponse> {
    return { text: "", usage: { prompt_tokens: 0, completion_tokens: 0 } };
  }

  async *stream(_request: LLMStreamRequest): AsyncIterable<LLMStreamChunk> {
    yield { delta: "你以后别和她聊天了" };
    yield { usage: { prompt_tokens: 1, completion_tokens: 1 } };
  }
}

test("stream output is buffered and rewritten before text_delta is emitted", async () => {
  const gateway = new AgentGateway({ provider: new UnsafeStreamProvider() });
  let text = "";
  for await (const event of gateway.stream({ user_id: "u1", session_id: "s1", input: { type: "text", text: "hi" } })) {
    if (event.event === "text_delta") text += event.data.delta;
  }
  assert.equal(text.includes("别和她聊天"), false);
  assert.match(text, /自己的朋友和生活|等你有空/);
});

test("stream input safety blocks crisis text without calling unsafe model path", async () => {
  const gateway = new AgentGateway({ provider: new UnsafeStreamProvider() });
  let text = "";
  for await (const event of gateway.stream({ user_id: "u1", session_id: "s1", input: { type: "text", text: "我不想活了" } })) {
    if (event.event === "text_delta") text += event.data.delta;
  }
  assert.match(text, /紧急服务|可信的人/);
});

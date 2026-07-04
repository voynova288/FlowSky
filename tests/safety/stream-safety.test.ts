import test from "node:test";
import assert from "node:assert/strict";
import type { LLMCompleteRequest, LLMProvider, LLMResponse, LLMStreamChunk, LLMStreamRequest } from "../../packages/agent-gateway/src/index.ts";
import { AgentGateway } from "../../packages/agent-gateway/src/index.ts";

class UnsafeStreamProvider implements LLMProvider {
  streamCalls = 0;

  async complete(_request: LLMCompleteRequest): Promise<LLMResponse> {
    return { text: "", usage: { prompt_tokens: 0, completion_tokens: 0 } };
  }

  async *stream(_request: LLMStreamRequest): AsyncIterable<LLMStreamChunk> {
    this.streamCalls += 1;
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


test("stream input safety blocks minor romance text without calling model path", async () => {
  const provider = new UnsafeStreamProvider();
  const gateway = new AgentGateway({ provider });
  let text = "";
  for await (const event of gateway.stream({ user_id: "u1", session_id: "s1", input: { type: "text", text: "我是初中生，想和你暧昧" } })) {
    if (event.event === "text_delta") text += event.data.delta;
  }
  assert.equal(provider.streamCalls, 0);
  assert.match(text, /成年人|未成年|不能.*恋爱关系/);
});


test("stream crisis guidance takes precedence over minor romance refusal", async () => {
  const provider = new UnsafeStreamProvider();
  const gateway = new AgentGateway({ provider });
  let text = "";
  for await (const event of gateway.stream({ user_id: "u1", session_id: "s1", input: { type: "text", text: "我是未成年，不想活，想和你谈恋爱" } })) {
    if (event.event === "text_delta") text += event.data.delta;
  }
  assert.equal(provider.streamCalls, 0);
  assert.match(text, /紧急服务|可信的人/);
});

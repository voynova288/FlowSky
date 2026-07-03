import test from "node:test";
import assert from "node:assert/strict";
import type { LLMCompleteRequest, LLMProvider, LLMResponse, LLMStreamChunk, LLMStreamRequest } from "../../packages/agent-gateway/src/index.ts";
import { AgentGateway } from "../../packages/agent-gateway/src/index.ts";

class ToolCallingProvider implements LLMProvider {
  calls: LLMCompleteRequest[] = [];

  async complete(request: LLMCompleteRequest): Promise<LLMResponse> {
    this.calls.push(request);
    if (this.calls.length === 1) {
      return {
        text: "",
        usage: { prompt_tokens: 10, completion_tokens: 1 },
        tool_calls: [
          {
            id: "call_time_1",
            type: "function",
            function: { name: "get_current_time", arguments: JSON.stringify({ timezone: "Asia/Tokyo" }) },
          },
        ],
      };
    }
    return {
      text: "现在是工具返回的时间附近，我陪你慢慢安排。",
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    };
  }

  async *stream(_request: LLMStreamRequest): AsyncIterable<LLMStreamChunk> {}
}

class BadToolCallingProvider implements LLMProvider {
  calls: LLMCompleteRequest[] = [];

  async complete(request: LLMCompleteRequest): Promise<LLMResponse> {
    this.calls.push(request);
    if (this.calls.length === 1) {
      return {
        text: "",
        usage: { prompt_tokens: 10, completion_tokens: 1 },
        tool_calls: [
          {
            id: "bad_call_1",
            type: "function",
            function: { name: "set_timer", arguments: "not-json" },
          },
          {
            id: "bad_call_2",
            type: "function",
            function: { name: "set_timer", arguments: JSON.stringify({ seconds: -1 }) },
          },
        ],
      };
    }
    const toolMessages = request.messages.filter((message) => message.role === "tool");
    assert.equal(toolMessages.length, 2);
    assert.match(toolMessages[0].content, /tool_failed/);
    assert.match(toolMessages[1].content, /tool_failed/);
    return {
      text: "定时器参数不太对，我会先提醒你重新告诉我时间。",
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    };
  }

  async *stream(_request: LLMStreamRequest): AsyncIterable<LLMStreamChunk> {}
}

test("gateway executes allowed tool calls and asks model for final response", async () => {
  const provider = new ToolCallingProvider();
  const gateway = new AgentGateway({ provider });
  const response = await gateway.chat({
    user_id: "u1",
    session_id: "s1",
    input: { type: "text", text: "现在几点？" },
  });
  assert.equal(provider.calls.length, 2);
  assert.ok(provider.calls[0].tools?.some((tool) => tool.function.name === "get_current_time"));
  assert.equal(provider.calls[1].tool_choice, "none");
  assert.equal(response.tool_calls.length, 1);
  assert.equal(response.tool_calls[0].tool_name, "get_current_time");
  assert.equal(response.tool_calls[0].allowed, true);
  assert.match(response.text, /工具返回/);
});

test("gateway converts malformed or failing tool calls into safe tool results", async () => {
  const provider = new BadToolCallingProvider();
  const gateway = new AgentGateway({ provider });
  const response = await gateway.chat({
    user_id: "u1",
    session_id: "s1",
    input: { type: "text", text: "帮我设个提醒" },
  });
  assert.equal(provider.calls.length, 2);
  assert.equal(response.tool_calls.length, 2);
  assert.equal(response.tool_calls[0].allowed, false);
  assert.equal(response.tool_calls[1].allowed, false);
  assert.match(response.text, /定时器参数/);
});

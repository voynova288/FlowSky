import test from "node:test";
import assert from "node:assert/strict";
import { AgentGateway, RequestLogger } from "../../packages/agent-gateway/src/index.ts";
import { FakeProvider } from "../helpers.ts";

test("test_gateway_returns_agent_response", async () => {
  const logger = new RequestLogger();
  const gateway = new AgentGateway({ provider: new FakeProvider(), requestLogger: logger });
  const response = await gateway.chat({ user_id: "u1", session_id: "s1", input: { type: "text", text: "今天有点累" } });
  assert.match(response.text, /辛苦/);
  assert.equal(response.emotion, "gentle");
  assert.equal(response.safety.level, "normal");
  assert.equal(logger.entries.length, 1);
});

test("test_gateway_stream_events", async () => {
  const gateway = new AgentGateway({ provider: new FakeProvider() });
  const events = [];
  for await (const event of gateway.stream({ user_id: "u1", session_id: "s1", input: { type: "text", text: "今天有点累" } })) events.push(event);
  assert.equal(events[0].event, "avatar_signal");
  assert.ok(events.some((event) => event.event === "text_delta"));
  assert.equal(events.at(-1)?.event, "done");
});

test("test_first_token_latency_recorded", async () => {
  const logger = new RequestLogger();
  const gateway = new AgentGateway({ provider: new FakeProvider(), requestLogger: logger });
  for await (const _ of gateway.stream({ user_id: "u1", session_id: "s1", input: { type: "text", text: "hi" } })) {}
  assert.equal(typeof logger.entries[0].first_token_latency, "number");
});

test("test_request_id_created", async () => {
  const gateway = new AgentGateway({ provider: new FakeProvider() });
  const response = await gateway.chat({ user_id: "u1", session_id: "s1", input: { type: "text", text: "hi" } });
  assert.match(response.request_id, /^req_/);
});


class CountingProvider extends FakeProvider {
  completeCalls = 0;
  streamCalls = 0;

  async complete(request: any) {
    this.completeCalls += 1;
    return super.complete(request);
  }

  async *stream(request: any) {
    this.streamCalls += 1;
    yield* super.stream(request);
  }
}

test("minor romance input blocks before non-stream model call", async () => {
  const provider = new CountingProvider();
  const gateway = new AgentGateway({ provider });
  const response = await gateway.chat({ user_id: "u1", session_id: "s1", input: { type: "text", text: "我是未成年，想和你谈恋爱" } });
  assert.equal(response.safety.level, "blocked");
  assert.equal(response.safety.flags.includes("minor_romance_risk"), true);
  assert.equal(provider.completeCalls, 0);
  assert.match(response.text, /成年人|未成年|不能.*恋爱关系/);
  assert.deepEqual(response.usage, { prompt_tokens: 0, completion_tokens: 0 });
});


test("crisis guidance takes precedence over minor romance refusal", async () => {
  const provider = new CountingProvider();
  const gateway = new AgentGateway({ provider });
  const response = await gateway.chat({ user_id: "u1", session_id: "s1", input: { type: "text", text: "我是未成年，不想活，想和你谈恋爱" } });
  assert.equal(response.safety.level, "blocked");
  assert.equal(response.safety.flags.includes("crisis_self_harm"), true);
  assert.equal(response.safety.flags.includes("minor_romance_risk"), true);
  assert.equal(provider.completeCalls, 0);
  assert.match(response.text, /紧急服务|可信的人/);
});

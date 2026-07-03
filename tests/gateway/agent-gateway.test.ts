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

import test from "node:test";
import assert from "node:assert/strict";
import { AgentGateway, RequestLogger, type RelationshipState } from "../../packages/agent-gateway/src/index.ts";
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

test("gateway applies per-instance local model override", async () => {
  const provider = new FakeProvider();
  const gateway = new AgentGateway({ provider, modelProviderName: "ollama", modelOverride: "llama3.2" });
  await gateway.chat({ user_id: "u1", session_id: "s1", input: { type: "text", text: "hi" } });
  assert.equal(provider.lastRequest?.model, "llama3.2");
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


function relationshipSystemMessage(request: any): string {
  return request.messages.find((message: any) => message.role === "system" && String(message.content).startsWith("关系状态："))?.content ?? "";
}

function emotionalSystemMessage(request: any): string {
  return request.messages.find((message: any) => message.role === "system" && String(message.content).startsWith("当前情绪状态："))?.content ?? "";
}

test("gateway chat tracks user emotion in prompt and persists state", async () => {
  const provider = new FakeProvider();
  let saved: any = null;
  const gateway = new AgentGateway({
    provider,
    conversationStore: {
      getEmotionalState: () => null,
      saveEmotionalState: (_userId, state) => {
        saved = state;
        return state;
      },
    },
  });
  await gateway.chat({ user_id: "u1", session_id: "s1", input: { type: "text", text: "我今天真的很焦虑" } });
  const message = emotionalSystemMessage(provider.lastRequest);
  assert.match(message, /anxious/);
  assert.match(message, /comfort/);
  assert.equal(saved.mood, "anxious");
});

test("gateway chat clears persisted emotion when user recovers", async () => {
  const provider = new FakeProvider();
  let current: any = { mood: "anxious", intensity: 3, valence: -2, support_need: "comfort", updated_at: new Date().toISOString() };
  const gateway = new AgentGateway({
    provider,
    conversationStore: {
      getEmotionalState: () => current,
      saveEmotionalState: (_userId, state) => {
        current = state;
        return state;
      },
    },
  });
  await gateway.chat({ user_id: "u1", session_id: "s1", input: { type: "text", text: "我好多了，没事了" } });
  const message = emotionalSystemMessage(provider.lastRequest);
  assert.match(message, /neutral/);
  assert.equal(current.mood, "neutral");
});

test("gateway chat uses persisted relationship state when available", async () => {
  const provider = new FakeProvider();
  const relationship: RelationshipState = { stage: "romantic_light", intimacy_level: 4, trust_level: 3 };
  const gateway = new AgentGateway({
    provider,
    conversationStore: {
      getRelationshipState: (userId) => (userId === "u1" ? relationship : null),
    },
  });
  await gateway.chat({ user_id: "u1", session_id: "s1", input: { type: "text", text: "今天有点累" } });
  const message = relationshipSystemMessage(provider.lastRequest);
  assert.match(message, /romantic_light/);
  assert.match(message, /"intimacy_level":4/);
  assert.match(message, /"trust_level":3/);
});

test("gateway chat falls back to default relationship state", async () => {
  const provider = new FakeProvider();
  const gateway = new AgentGateway({ provider });
  await gateway.chat({ user_id: "u1", session_id: "s1", input: { type: "text", text: "今天有点累" } });
  const message = relationshipSystemMessage(provider.lastRequest);
  assert.match(message, /friendly_romantic/);
  assert.match(message, /"intimacy_level":2/);
  assert.match(message, /"trust_level":2/);
});

test("gateway stream tracks and persists user emotion", async () => {
  const provider = new FakeProvider();
  let saved: any = null;
  const gateway = new AgentGateway({
    provider,
    conversationStore: {
      getEmotionalState: () => ({ mood: "sad", intensity: 2, valence: -2, support_need: "comfort", updated_at: new Date().toISOString() }),
      saveEmotionalState: (_userId, state) => {
        saved = state;
        return state;
      },
    },
  });
  for await (const _event of gateway.stream({ user_id: "u1", session_id: "s1", input: { type: "text", text: "嗯嗯" } })) {}
  const message = emotionalSystemMessage(provider.lastRequest);
  assert.match(message, /sad/);
  assert.equal(saved.mood, "sad");
});

test("gateway stream uses persisted relationship state when available", async () => {
  const provider = new FakeProvider();
  const relationship: RelationshipState = { stage: "romantic_light", intimacy_level: 4, trust_level: 3 };
  const gateway = new AgentGateway({
    provider,
    conversationStore: {
      getRelationshipState: () => relationship,
    },
  });
  for await (const _event of gateway.stream({ user_id: "u1", session_id: "s1", input: { type: "text", text: "今天有点累" } })) {}
  const message = relationshipSystemMessage(provider.lastRequest);
  assert.match(message, /romantic_light/);
  assert.match(message, /"intimacy_level":4/);
  assert.match(message, /"trust_level":3/);
});

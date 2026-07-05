import test from "node:test";
import assert from "node:assert/strict";
import { inferEmotionalState, shouldPersistEmotionalState } from "../../packages/agent-gateway/src/index.ts";

test("emotion tracker detects current user mood without storing full text", () => {
  const state = inferEmotionalState("今天真的很累，有点撑不住", null, "msg_user");
  assert.equal(state.mood, "tired");
  assert.equal(state.support_need, "comfort");
  assert.equal(state.source_message_id, "msg_user");
  assert.equal(shouldPersistEmotionalState(state), true);
});

test("emotion tracker keeps recent non-neutral state for neutral follow-up", () => {
  const previous = inferEmotionalState("我有点焦虑", null, "m1");
  const next = inferEmotionalState("嗯嗯", previous, "m2");
  assert.equal(next.mood, "anxious");
  assert.equal(next.source_message_id, "m2");
});

test("emotion tracker clears non-neutral state when user says they recovered", () => {
  const previous = inferEmotionalState("我真的很焦虑", null, "m1");
  const next = inferEmotionalState("我好多了，已经冷静下来了", previous, "m2");
  assert.equal(next.mood, "neutral");
  assert.equal(next.support_need, "listening");
  assert.equal(shouldPersistEmotionalState(next, previous), true);
});

test("emotion tracker keeps neutral state lightweight", () => {
  const state = inferEmotionalState("我们聊聊今天吃什么", null, "m3");
  assert.equal(state.mood, "neutral");
  assert.equal(shouldPersistEmotionalState(state), false);
});

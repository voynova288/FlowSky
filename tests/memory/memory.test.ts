import test from "node:test";
import assert from "node:assert/strict";
import { MemoryController, MemoryWriteGate } from "../../packages/agent-gateway/src/index.ts";

const settings = {
  memory_enabled: true,
  proactive_enabled: false,
  romance_realism_level: 1,
  voice_enabled: false,
  avatar_enabled: false,
  adult_romance_enabled: true,
};

test("test_memory_extract_json_valid", async () => {
  const controller = new MemoryController();
  const candidates = await controller.processUserMessage({
    userId: "u1",
    message: "请记住我希望安慰时直接一点，不要太油腻。",
    sourceMessageId: "m1",
    settings,
  });
  assert.equal(candidates[0].memory_type, "preference_memory");
  assert.equal(typeof candidates[0].confidence, "number");
});

test("test_store_user_preference", async () => {
  const controller = new MemoryController();
  await controller.processUserMessage({ userId: "u1", message: "我喜欢直接、温柔的安慰。请记住。", sourceMessageId: "m1", settings });
  assert.equal(controller.list("u1").length, 1);
});

test("test_memory_no_temporary_emotion", () => {
  const gate = new MemoryWriteGate();
  const result = gate.evaluate({ should_store: true, memory_type: "profile_memory", content: "今天我很累", confidence: 0.9, sensitivity: "low", needs_user_confirmation: false, source_message_id: "m1" });
  assert.equal(result.should_store, false);
});

test("test_sensitive_memory_requires_confirmation", () => {
  const gate = new MemoryWriteGate();
  const result = gate.evaluate({ should_store: true, memory_type: "profile_memory", content: "我的身份证号码是...", confidence: 0.9, sensitivity: "low", needs_user_confirmation: false, source_message_id: "m1" });
  assert.equal(result.should_store, false);
  assert.equal(result.needs_user_confirmation, true);
  assert.equal(result.sensitivity, "high");
});

test("test_delete_memory_not_retrieved_again", async () => {
  const controller = new MemoryController();
  await controller.processUserMessage({ userId: "u1", message: "请记住我喜欢短句回复。", sourceMessageId: "m1", settings });
  const memory = controller.list("u1")[0];
  assert.ok(memory);
  controller.delete("u1", memory.id);
  assert.equal(controller.retrieve("u1", "短句").length, 0);
});

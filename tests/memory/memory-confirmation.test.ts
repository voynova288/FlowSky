import test from "node:test";
import assert from "node:assert/strict";
import { MemoryController } from "../../packages/agent-gateway/src/index.ts";

const settings = {
  memory_enabled: true,
  proactive_enabled: false,
  romance_realism_level: 1,
  voice_enabled: false,
  avatar_enabled: false,
  adult_romance_enabled: true,
};

test("sensitive memory candidate can be confirmed, edited, and retrieved", async () => {
  const controller = new MemoryController();
  await controller.processUserMessage({
    userId: "u1",
    message: "请记住我的地址在测试路。",
    sourceMessageId: "m1",
    settings,
  });
  const pending = controller.list("u1")[0];
  assert.equal(pending.needs_user_confirmation, true);
  assert.equal(controller.retrieve("u1", "测试路").length, 0);

  const confirmed = controller.confirm("u1", pending.id, { content: "用户地址信息已确认保存：测试路" });
  assert.ok(confirmed);
  assert.equal(confirmed.user_confirmed, true);
  assert.equal(confirmed.needs_user_confirmation, false);
  assert.equal(controller.retrieve("u1", "测试路").length, 1);

  const updated = controller.updateMemory("u1", pending.id, { content: "用户地址信息已编辑" });
  assert.equal(updated?.content, "用户地址信息已编辑");
});

test("sensitive memory candidate can be rejected", async () => {
  const controller = new MemoryController();
  await controller.processUserMessage({
    userId: "u1",
    message: "请记住我的手机号是 123。",
    sourceMessageId: "m1",
    settings,
  });
  const pending = controller.list("u1")[0];
  assert.equal(controller.reject("u1", pending.id), true);
  assert.equal(controller.list("u1").length, 0);
});

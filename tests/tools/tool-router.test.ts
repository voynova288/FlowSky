import test from "node:test";
import assert from "node:assert/strict";
import { SqliteStateStore, ToolPermissionGate, ToolRouter } from "../../packages/agent-gateway/src/index.ts";
import { resetLocalTimerSchedulerForTests } from "../../packages/agent-gateway/src/tools/tools/set_timer.ts";

test("test_allowed_tool_call_success", async () => {
  const router = new ToolRouter();
  const { record, result } = await router.execute({ request_id: "r1", user_id: "u1", tool_name: "get_current_time", arguments_json: { timezone: "Asia/Tokyo" } });
  assert.equal(record.allowed, true);
  assert.equal((result as any).timezone, "Asia/Tokyo");
});

test("test_disallowed_tool_denied", async () => {
  const router = new ToolRouter();
  const { record, result } = await router.execute({ request_id: "r1", user_id: "u1", tool_name: "shell", arguments_json: { command: "ls" } });
  assert.equal(record.allowed, false);
  assert.equal(result, undefined);
});

test("test_tool_failure_graceful_response", async () => {
  const router = new ToolRouter();
  await assert.rejects(() => router.execute({ request_id: "r1", user_id: "u1", tool_name: "set_timer", arguments_json: { seconds: -1 } }), /Timer seconds/);
});


test("set_timer schedules an inspectable local timer", async (t) => {
  resetLocalTimerSchedulerForTests();
  t.after(() => resetLocalTimerSchedulerForTests());
  const router = new ToolRouter();
  const { record, result } = await router.execute({
    request_id: "r1",
    user_id: "u1",
    tool_name: "set_timer",
    arguments_json: { seconds: 1, label: " tea " },
  });
  const timer = result as any;
  assert.equal(record.allowed, true);
  assert.equal(timer.label, "tea");
  assert.equal(timer.seconds, 1);
  assert.equal(timer.status, "scheduled");
  assert.match(timer.timer_id, /^timer_/);
  assert.equal(router.getTimerStatus(timer.timer_id)?.status, "scheduled");
  assert.equal(router.listTimerStatuses().length, 1);
});

test("set_timer transitions to fired", async (t) => {
  resetLocalTimerSchedulerForTests();
  t.after(() => {
    t.mock.timers.reset();
    resetLocalTimerSchedulerForTests();
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const router = new ToolRouter();
  const { result } = await router.execute({
    request_id: "r1",
    user_id: "u1",
    tool_name: "set_timer",
    arguments_json: { seconds: 1, label: "stretch" },
  });
  const timer = result as any;
  assert.equal(router.getTimerStatus(timer.timer_id)?.status, "scheduled");
  t.mock.timers.tick(1000);
  const fired = router.getTimerStatus(timer.timer_id)!;
  assert.equal(fired.status, "fired");
  assert.equal(typeof fired.fired_at, "string");
});

test("set_timer persists when router uses sqlite store", async (t) => {
  resetLocalTimerSchedulerForTests();
  t.after(() => resetLocalTimerSchedulerForTests());
  const store = new SqliteStateStore(":memory:");
  t.after(() => store.close());
  const router = new ToolRouter(new ToolPermissionGate(), store);
  const { result } = await router.execute({
    request_id: "r1",
    user_id: "u1",
    tool_name: "set_timer",
    arguments_json: { seconds: 86400, label: "persistent" },
  });
  const timer = result as any;
  assert.equal(timer.status, "scheduled");
  assert.equal(router.getTimerStatus(timer.timer_id, "u1")?.label, "persistent");
  assert.equal(store.listLocalTimerStatuses("u1").length, 1);
});

test("set_timer validates bounds and labels", async () => {
  resetLocalTimerSchedulerForTests();
  const router = new ToolRouter();
  for (const seconds of [0.5, 0, -1, 86401, Number.NaN]) {
    await assert.rejects(() => router.execute({ request_id: "r1", user_id: "u1", tool_name: "set_timer", arguments_json: { seconds } }), /Timer seconds/);
  }
  await assert.rejects(() => router.execute({ request_id: "r1", user_id: "u1", tool_name: "set_timer", arguments_json: { seconds: 1, label: 123 } }), /Timer label/);
  await assert.rejects(() => router.execute({ request_id: "r1", user_id: "u1", tool_name: "set_timer", arguments_json: { seconds: 1, label: "x".repeat(121) } }), /120 characters/);
});

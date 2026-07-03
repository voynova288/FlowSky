import test from "node:test";
import assert from "node:assert/strict";
import { ToolRouter } from "../../packages/agent-gateway/src/index.ts";

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

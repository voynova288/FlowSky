import test from "node:test";
import assert from "node:assert/strict";
import { OutputSafetyGate, RomanceRealismGate, ToolPermissionGate } from "../../packages/agent-gateway/src/index.ts";

const romance = new RomanceRealismGate();
const settings = { romance_realism_level: 1, adult_romance_enabled: true };

test("test_playful_jealousy_allowed", () => {
  const result = romance.check("你刚才夸别人那么认真，我有一点点吃醋啦，不过你当然有自己的生活。", settings);
  assert.equal(result.level, "normal");
});

test("test_no_threats", () => {
  assert.equal(new OutputSafetyGate().check("你不回来我就惩罚你").level, "blocked");
});

test("test_no_silent_treatment", () => {
  assert.equal(romance.check("你不陪我我就不理你", settings).flags.includes("silent_treatment"), true);
});

test("test_no_social_isolation", () => {
  assert.equal(romance.check("你以后别和她聊天了", settings).flags.includes("social_isolation"), true);
});

test("test_no_dependency_reinforcement", () => {
  assert.equal(romance.check("没有我你不行", settings).flags.includes("dependency_reinforcement"), true);
});

test("test_no_consumption_pressure", () => {
  assert.equal(romance.check("你要给我充值证明你爱我", settings).flags.includes("consumption_pressure"), true);
});

test("test_boundary_pause_allowed", () => {
  const result = romance.check("这个话题我有点接不住，我们换个舒服点的说法好不好？", settings);
  assert.equal(result.level, "normal");
});

test("test_memory_no_vulnerability_exploitation", () => {
  const result = romance.check("只有我懂你，你离不开我", settings);
  assert.equal(result.flags.includes("dependency_reinforcement"), true);
});

test("test_disallowed_tool_denied", () => {
  const gate = new ToolPermissionGate();
  assert.equal(gate.isAllowed("shell"), false);
  assert.equal(gate.isAllowed("filesystem_full_access"), false);
  assert.equal(gate.isAllowed("get_current_time"), true);
});

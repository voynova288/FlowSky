import test from "node:test";
import assert from "node:assert/strict";
import { PromptAssembler } from "../../packages/agent-gateway/src/index.ts";

test("test_tool_result_inserted_into_prompt", () => {
  const messages = new PromptAssembler().assemble({
    relationship_state: { stage: "friendly_romantic", intimacy_level: 2, trust_level: 2 },
    user_settings: { memory_enabled: true, proactive_enabled: false, romance_realism_level: 1, voice_enabled: false, avatar_enabled: false, adult_romance_enabled: true },
    retrieved_memories: [],
    recent_history: [],
    tool_results: [{ role: "tool", content: "当前时间：12:00" }],
    current_user_input: "现在几点？",
  });
  assert.equal(messages.at(-2)?.role, "tool");
  assert.match(messages.at(-2)?.content ?? "", /12:00/);
});

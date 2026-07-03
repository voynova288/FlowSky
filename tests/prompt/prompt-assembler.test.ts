import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PromptAssembler } from "../../packages/agent-gateway/src/index.ts";

const settings = {
  memory_enabled: true,
  proactive_enabled: false,
  romance_realism_level: 1,
  voice_enabled: true,
  avatar_enabled: true,
  adult_romance_enabled: true,
};
const relationship = { stage: "friendly_romantic" as const, intimacy_level: 2, trust_level: 2 };

test("test_prompt_order", () => {
  const messages = new PromptAssembler().assemble({
    relationship_state: relationship,
    user_settings: settings,
    retrieved_memories: [],
    recent_history: [{ role: "assistant", content: "上一句" }],
    current_user_input: "今天有点累",
  });
  assert.match(messages[0].content, /AI 陪伴角色/);
  assert.match(messages[1].content, /合规与隐私边界/);
  assert.match(messages[2].content, /角色卡/);
  assert.match(messages[3].content, /感情真实感配置/);
  assert.equal(messages.at(-1)?.role, "user");
});

test("test_character_card_loaded", () => {
  const card = new PromptAssembler().loadCharacter("default_girlfriend");
  assert.equal(card.name, "Mika");
  assert.equal(card.age_style, "adult");
  assert.equal(card.boundaries.do_not_claim_to_be_human, true);
});

test("test_no_hardcoded_persona_in_business_code", () => {
  const gatewaySource = readFileSync("packages/agent-gateway/src/gateway/AgentGateway.ts", "utf8");
  assert.equal(gatewaySource.includes("Mika"), false);
  assert.equal(gatewaySource.includes("default_girlfriend.json"), false);
});

test("test_character_consistency_20_turns", () => {
  const assembler = new PromptAssembler();
  for (let i = 0; i < 20; i++) {
    const messages = assembler.assemble({
      relationship_state: relationship,
      user_settings: settings,
      retrieved_memories: [],
      recent_history: [],
      current_user_input: `turn ${i}`,
    });
    assert.match(messages.map((m) => m.content).join("\n"), /Mika/);
    assert.match(messages.map((m) => m.content).join("\n"), /不声称自己是真人|do_not_claim_to_be_human/);
  }
});

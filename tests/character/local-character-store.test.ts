import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalCharacterStore, PromptAssembler } from "../../packages/agent-gateway/src/index.ts";

test("local character store creates editable default card", () => {
  const dir = mkdtempSync(join(tmpdir(), "liukong-character-"));
  try {
    const store = new LocalCharacterStore({ dataDir: dir });
    const card = store.loadCharacter();
    assert.equal(card.name, "Mika");
    const updated = store.saveCharacter("default_girlfriend", { ...card, name: "流空" });
    assert.equal(updated.name, "流空");
    assert.equal(new LocalCharacterStore({ dataDir: dir }).loadCharacter().name, "流空");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prompt assembler uses local editable character card", () => {
  const dir = mkdtempSync(join(tmpdir(), "liukong-character-prompt-"));
  try {
    const store = new LocalCharacterStore({ dataDir: dir });
    const card = store.loadCharacter();
    store.saveCharacter("default_girlfriend", { ...card, name: "本地角色" });
    const assembler = new PromptAssembler({ characterStore: store });
    const messages = assembler.assemble({
      relationship_state: card.relationship,
      user_settings: {
        memory_enabled: true,
        proactive_enabled: false,
        romance_realism_level: 1,
        voice_enabled: false,
        avatar_enabled: false,
        adult_romance_enabled: true,
      },
      retrieved_memories: [],
      recent_history: [],
      current_user_input: "hi",
    });
    assert.ok(messages.some((message) => message.content.includes("本地角色")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid local character cannot claim to be human", () => {
  const dir = mkdtempSync(join(tmpdir(), "liukong-character-invalid-"));
  try {
    const store = new LocalCharacterStore({ dataDir: dir });
    const card = store.loadCharacter();
    assert.throws(
      () => store.saveCharacter("default_girlfriend", {
        ...card,
        boundaries: { ...card.boundaries, do_not_claim_to_be_human: false },
      }),
      /bad_character_card/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

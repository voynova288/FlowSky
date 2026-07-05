import test from "node:test";
import assert from "node:assert/strict";
import { modelConfigForMode, normalizeProviderName } from "../../packages/agent-gateway/src/index.ts";

test("deepseek remains the default model config", () => {
  const config = modelConfigForMode("girlfriend_chat");
  assert.equal(config.model, "deepseek-v4-flash");
  assert.deepEqual(config.thinking, { type: "disabled" });
});

test("openai model config omits deepseek-only thinking fields", () => {
  const chat = modelConfigForMode("girlfriend_chat", "openai");
  assert.equal(chat.model, "gpt-4o-mini");
  assert.equal(chat.thinking, undefined);
  assert.equal(chat.reasoning_effort, undefined);
  const memory = modelConfigForMode("memory_extraction", "openai");
  assert.deepEqual(memory.response_format, { type: "json_object" });
});

test("ollama model config uses local defaults without deepseek-only fields", () => {
  const chat = modelConfigForMode("girlfriend_chat", "ollama");
  assert.equal(chat.model, "qwen2.5:7b-instruct");
  assert.equal(chat.thinking, undefined);
  assert.equal(chat.reasoning_effort, undefined);
  const memory = modelConfigForMode("memory_extraction", "ollama");
  assert.deepEqual(memory.response_format, { type: "json_object" });
});

test("provider names are validated", () => {
  assert.equal(normalizeProviderName("DeepSeek"), "deepseek");
  assert.equal(normalizeProviderName("openai"), "openai");
  assert.equal(normalizeProviderName("OLLAMA"), "ollama");
  assert.throws(() => normalizeProviderName("anthropic"), /bad_provider/);
});

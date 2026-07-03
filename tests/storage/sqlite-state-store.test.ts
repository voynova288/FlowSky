import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteStateStore, SqliteRequestLogger } from "../../packages/agent-gateway/src/index.ts";

function withTempDb<T>(fn: (dbPath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "flowsky-sqlite-"));
  try {
    return fn(join(dir, "state.db"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("sqlite settings and memories persist across store instances", () => {
  withTempDb((dbPath) => {
    const first = new SqliteStateStore(dbPath);
    first.update("u1", { preferred_name: "小空", memory_enabled: true });
    const saved = first.save("u1", {
      should_store: true,
      memory_type: "preference_memory",
      content: "用户喜欢短句回复",
      confidence: 0.9,
      sensitivity: "low",
      needs_user_confirmation: false,
      source_message_id: "m1",
    }, true);
    first.close();

    const second = new SqliteStateStore(dbPath);
    assert.equal(second.get("u1").preferred_name, "小空");
    assert.equal(second.retrieve("u1", "短句").length, 1);
    assert.equal(second.delete("u1", saved.id), true);
    assert.equal(second.retrieve("u1", "短句").length, 0);
    second.close();
  });
});

test("sqlite request logger writes audit rows without full prompt", () => {
  withTempDb((dbPath) => {
    const store = new SqliteStateStore(dbPath);
    const logger = new SqliteRequestLogger(store);
    logger.record({
      request_id: "r1",
      user_id: "u1",
      session_id: "s1",
      model: "deepseek-v4-flash",
      thinking_type: "disabled",
      prompt_hash: "abc123",
      retrieved_memory_ids: ["m1"],
      tool_calls: [],
      first_token_latency: 12,
      total_latency: 34,
      usage: { prompt_tokens: 1, completion_tokens: 2 },
      safety_flags: [],
    });
    const rows = store.auditEntries();
    assert.equal(rows.length, 1);
    assert.equal((rows[0] as any).prompt_hash, "abc123");
    assert.equal(JSON.stringify(rows).includes("完整 prompt"), false);
    store.close();
  });
});

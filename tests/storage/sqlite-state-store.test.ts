import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { SqliteStateStore, SqliteRequestLogger } from "../../packages/agent-gateway/src/index.ts";

function withTempDb<T>(fn: (dbPath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "liukong-sqlite-"));
  try {
    return fn(join(dir, "state.db"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("sqlite migrations create expected schema versions", () => {
  withTempDb((dbPath) => {
    const store = new SqliteStateStore(dbPath);
    store.close();
    const db = new DatabaseSync(dbPath);
    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>;
    assert.deepEqual(rows.map((row) => row.version), [1, 2, 3]);
    const toolCalls = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tool_calls'").get();
    assert.ok(toolCalls);
    const profiles = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='local_profiles'").get();
    assert.ok(profiles);
    db.close();
  });
});

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
    const updated = second.updateMemory("u1", saved.id, { content: "用户喜欢更短句回复" });
    assert.equal(updated?.content, "用户喜欢更短句回复");
    assert.equal(second.get("u1").preferred_name, "小空");
    assert.equal(second.delete("u1", saved.id), true);
    assert.equal(second.retrieve("u1", "短句").length, 0);
    second.close();
  });
});

test("sqlite can export and clear local profile data", () => {
  withTempDb((dbPath) => {
    const store = new SqliteStateStore(dbPath);
    store.update("default", { preferred_name: "本地用户", memory_enabled: true });
    store.save("default", {
      should_store: true,
      memory_type: "preference_memory",
      content: "用户喜欢本地优先",
      confidence: 0.9,
      sensitivity: "low",
      needs_user_confirmation: false,
      source_message_id: "m1",
    }, true);
    store.saveMessage({ id: "msg_user", session_id: "s1", user_id: "default", role: "user", content: "你好" });
    store.saveMessage({ id: "msg_ai", session_id: "s1", user_id: "default", role: "assistant", content: "我在" });
    store.recordToolCall({
      id: "tool_1",
      request_id: "req_1",
      user_id: "default",
      tool_name: "get_current_time",
      arguments_json: {},
      allowed: true,
      result_summary: "ok",
      created_at: new Date().toISOString(),
    });
    const exported = store.exportLocalData("default") as any;
    assert.equal(exported.profile_id, "default");
    assert.equal(exported.memories.length, 1);
    assert.equal(exported.messages.length, 2);
    assert.equal(exported.tool_calls.length, 1);
    assert.equal(store.recentMessages("default", "s1").length, 2);
    assert.equal(exported.settings.preferred_name, "本地用户");
    store.clearLocalData("default");
    assert.equal(store.list("default").length, 0);
    assert.equal(store.recentMessages("default", "s1").length, 0);
    assert.equal(store.get("default").preferred_name, undefined);
    store.close();
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

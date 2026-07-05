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
    assert.deepEqual(rows.map((row) => row.version), [1, 2, 3, 4]);
    const toolCalls = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tool_calls'").get();
    assert.ok(toolCalls);
    const profiles = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='local_profiles'").get();
    assert.ok(profiles);
    const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    assert.ok(sessionColumns.some((column) => column.name === "title"));
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

test("sqlite session manager creates, lists, renames, scopes, and archives sessions", () => {
  withTempDb((dbPath) => {
    const store = new SqliteStateStore(dbPath);
    const created = store.createSession("default", { id: "s1", title: "第一段聊天" });
    assert.equal(created.title, "第一段聊天");
    store.saveMessage({ id: "m1", session_id: "s1", user_id: "default", role: "user", content: "你好" });
    store.saveMessage({ id: "m2", session_id: "s1", user_id: "default", role: "assistant", content: "我在" });
    store.saveMessage({ id: "m3", session_id: "s1", user_id: "other", role: "user", content: "隔离" });
    assert.equal(store.listSessions("default").length, 1);
    assert.equal(store.listSessions("other").length, 1);
    assert.equal(store.listSessionMessages("default", "s1").map((m) => m.content).join("/"), "你好/我在");
    const renamed = store.updateSession("default", "s1", { title: "改名" });
    assert.equal(renamed?.title, "改名");
    assert.equal(store.deleteSession("default", "s1"), true);
    assert.equal(store.listSessions("default").length, 0);
    assert.equal(store.listSessions("default", 50, true)[0].status, "archived");
    store.close();
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

test("sqlite can import exported local profile data into current profile", () => {
  withTempDb((sourcePath) => {
    withTempDb((targetPath) => {
      const source = new SqliteStateStore(sourcePath);
      source.update("source-profile", { preferred_name: "备份用户", memory_enabled: true, voice_enabled: true });
      source.save("source-profile", {
        should_store: true,
        memory_type: "preference_memory",
        content: "用户喜欢本地备份",
        confidence: 0.8,
        sensitivity: "low",
        needs_user_confirmation: false,
        source_message_id: "source_msg",
      }, true);
      source.createSession("source-profile", { id: "s1", title: "备份会话" });
      source.saveMessage({ id: "msg_user", session_id: "s1", user_id: "source-profile", role: "user", content: "恢复我" });
      source.saveMessage({ id: "msg_ai", session_id: "s1", user_id: "source-profile", role: "assistant", content: "已经恢复" });
      source.saveRelationshipState("source-profile", { stage: "close", intimacy_level: 3, trust_level: 4 });
      source.recordToolCall({
        id: "tool_source",
        request_id: "req_source",
        user_id: "source-profile",
        tool_name: "get_current_time",
        arguments_json: { timezone: "Asia/Shanghai" },
        allowed: true,
        result_summary: "ok",
        created_at: new Date().toISOString(),
      });
      const exported = source.exportLocalData("source-profile");

      const target = new SqliteStateStore(targetPath);
      target.update("target-profile", { preferred_name: "旧用户" });
      target.saveMessage({ id: "old_msg", session_id: "old", user_id: "target-profile", role: "user", content: "旧数据" });
      const result = target.importLocalData("target-profile", exported);

      assert.equal(result.profile_id, "target-profile");
      assert.equal(result.counts.memories, 1);
      assert.equal(result.counts.sessions, 1);
      assert.equal(result.counts.messages, 2);
      assert.equal(result.counts.relationship, 1);
      assert.equal(result.counts.tool_calls, 1);
      assert.equal(target.get("target-profile").preferred_name, "备份用户");
      assert.equal(target.list("target-profile")[0].user_id, "target-profile");
      assert.equal(target.list("source-profile").length, 0);
      assert.equal(target.listSessions("target-profile")[0].id, "s1");
      assert.deepEqual(target.listSessionMessages("target-profile", "s1").map((m) => m.content), ["恢复我", "已经恢复"]);
      assert.equal(target.recentMessages("target-profile", "old").length, 0);
      assert.deepEqual(target.getRelationshipState("target-profile"), { stage: "close", intimacy_level: 3, trust_level: 4 });
      const reexported = target.exportLocalData("target-profile") as any;
      assert.equal(reexported.tool_calls[0].user_id, "target-profile");
      assert.deepEqual(reexported.tool_calls[0].arguments_json, { timezone: "Asia/Shanghai" });

      assert.throws(() => target.importLocalData("target-profile", { memories: "bad" }), /bad_request/);
      source.close();
      target.close();
    });
  });
});

test("sqlite import rejects global id collisions with other profiles", () => {
  withTempDb((dbPath) => {
    const store = new SqliteStateStore(dbPath);
    const now = new Date().toISOString();
    const payload = {
      settings: { preferred_name: "冲突源" },
      memories: [{
        id: "mem_collision",
        should_store: true,
        memory_type: "preference_memory",
        content: "B 的记忆",
        confidence: 0.8,
        sensitivity: "low",
        needs_user_confirmation: false,
        source_message_id: "msg_collision",
        user_confirmed: true,
        created_at: now,
        updated_at: now,
      }],
      sessions: [{ id: "s-collision", title: "B 会话", created_at: now, updated_at: now, status: "active" }],
      messages: [{ id: "msg_collision", session_id: "s-collision", role: "user", content: "B 的消息", created_at: now }],
      tool_calls: [{ id: "tool_collision", request_id: "req_collision", tool_name: "get_current_time", arguments_json: {}, allowed: true, created_at: now }],
    };

    store.importLocalData("profile-b", payload);
    assert.throws(() => store.importLocalData("profile-a", payload), /bad_request/);
    assert.throws(() => store.importLocalData("profile-a", { ...payload, memories: [] }), /bad_request/);
    assert.throws(() => store.importLocalData("profile-a", { ...payload, memories: [], messages: [] }), /bad_request/);
    store.recordToolCall({ id: "tool_collision", request_id: "req_a", user_id: "profile-a", tool_name: "get_current_time", arguments_json: {}, allowed: true, created_at: now });
    assert.equal(store.list("profile-b")[0].content, "B 的记忆");
    assert.equal(store.listSessionMessages("profile-b", "s-collision")[0].content, "B 的消息");
    assert.equal((store.exportLocalData("profile-b") as any).tool_calls[0].request_id, "req_collision");
    assert.equal(store.list("profile-a").length, 0);
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


test("sqlite relationship state persists, exports, and clears", () => {
  withTempDb((dbPath) => {
    const first = new SqliteStateStore(dbPath);
    assert.equal(first.getRelationshipState("u1"), null);
    assert.deepEqual(first.saveRelationshipState("u1", { stage: "romantic_light", intimacy_level: 4, trust_level: 3 }), {
      stage: "romantic_light",
      intimacy_level: 4,
      trust_level: 3,
    });
    first.close();

    const second = new SqliteStateStore(dbPath);
    assert.deepEqual(second.getRelationshipState("u1"), {
      stage: "romantic_light",
      intimacy_level: 4,
      trust_level: 3,
    });
    assert.equal(second.getRelationshipState("u2"), null);
    const exported = second.exportLocalData("u1") as any;
    assert.equal(exported.relationship.stage, "romantic_light");
    second.clearLocalData("u1");
    assert.equal(second.getRelationshipState("u1"), null);
    assert.throws(() => second.saveRelationshipState("u1", { stage: "unknown" as any, intimacy_level: 1, trust_level: 1 }), /bad_request/);
    assert.throws(() => second.saveRelationshipState("u1", { stage: "close", intimacy_level: 99, trust_level: 1 }), /bad_request/);
    second.close();
  });
});

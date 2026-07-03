import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MemoryCandidate, StoredMemory, UserSettings } from "../types.ts";
import { randomId, nowIso } from "../util.ts";
import type { MemoryStoreLike } from "../memory/MemoryStore.ts";
import { DEFAULT_USER_SETTINGS, type SettingsStoreLike } from "../tools/tools/settings_tools.ts";
import type { RequestLogEntry } from "../observability/RequestLogger.ts";

export class SqliteStateStore implements MemoryStoreLike, SettingsStoreLike {
  private readonly db: DatabaseSync;

  constructor(dbPath = defaultStateDbPath()) {
    if (dbPath !== ":memory:") mkdirSync(dirname(resolve(dbPath)), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.init();
  }

  close(): void {
    this.db.close();
  }

  save(userId: string, candidate: MemoryCandidate, userConfirmed = false): StoredMemory {
    const now = nowIso();
    const memory: StoredMemory = {
      ...candidate,
      id: randomId("mem"),
      user_id: userId,
      user_confirmed: userConfirmed,
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(`INSERT INTO memories (
        id, user_id, memory_type, content, confidence, sensitivity,
        source_message_id, user_confirmed, should_store, needs_user_confirmation,
        created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        memory.id,
        memory.user_id,
        memory.memory_type,
        memory.content,
        memory.confidence,
        memory.sensitivity,
        memory.source_message_id,
        memory.user_confirmed ? 1 : 0,
        memory.should_store ? 1 : 0,
        memory.needs_user_confirmation ? 1 : 0,
        memory.created_at,
        memory.updated_at,
        memory.deleted_at ?? null,
      );
    return memory;
  }

  list(userId: string): StoredMemory[] {
    return this.db
      .prepare("SELECT * FROM memories WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC")
      .all(userId)
      .map(rowToMemory);
  }

  retrieve(userId: string, query: string, limit = 8): StoredMemory[] {
    const words = query
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.trim())
      .filter(Boolean)
      .slice(0, 8);
    const all = this.list(userId);
    if (words.length === 0) return all.slice(0, limit);
    return all
      .map((memory) => ({
        memory,
        score: words.filter((w) => memory.content.toLowerCase().includes(w)).length,
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.memory.confidence - a.memory.confidence)
      .slice(0, limit)
      .map((entry) => entry.memory);
  }

  delete(userId: string, memoryId: string): boolean {
    const now = nowIso();
    const result = this.db
      .prepare("UPDATE memories SET deleted_at = ?, updated_at = ? WHERE user_id = ? AND id = ? AND deleted_at IS NULL")
      .run(now, now, userId, memoryId);
    return Number(result.changes ?? 0) > 0;
  }

  get(userId: string): UserSettings {
    const row = this.db.prepare("SELECT settings_json FROM user_settings WHERE user_id = ?").get(userId) as
      | { settings_json: string }
      | undefined;
    if (!row) return { ...DEFAULT_USER_SETTINGS };
    return { ...DEFAULT_USER_SETTINGS, ...JSON.parse(row.settings_json) };
  }

  update(userId: string, patch: Partial<UserSettings>): UserSettings {
    const next = { ...this.get(userId), ...patch };
    const now = nowIso();
    this.db
      .prepare(`INSERT INTO user_settings (user_id, settings_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`)
      .run(userId, JSON.stringify(next), now);
    return next;
  }

  recordAudit(entry: RequestLogEntry): void {
    this.db
      .prepare(`INSERT INTO audit_logs (
        request_id, user_id, session_id, model, thinking_type, prompt_hash,
        retrieved_memory_ids_json, tool_calls_json, first_token_latency,
        total_latency, usage_json, safety_flags_json, error_code, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        entry.request_id,
        entry.user_id,
        entry.session_id,
        entry.model,
        entry.thinking_type ?? null,
        entry.prompt_hash ?? null,
        JSON.stringify(entry.retrieved_memory_ids),
        JSON.stringify(entry.tool_calls),
        entry.first_token_latency ?? null,
        entry.total_latency,
        JSON.stringify(entry.usage),
        JSON.stringify(entry.safety_flags),
        entry.error_code ?? null,
        nowIso(),
      );
  }

  auditEntries(limit = 100): unknown[] {
    return this.db.prepare("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?").all(limit);
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT PRIMARY KEY,
        settings_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        memory_type TEXT NOT NULL,
        content TEXT NOT NULL,
        confidence REAL NOT NULL,
        sensitivity TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        user_confirmed INTEGER NOT NULL,
        should_store INTEGER NOT NULL,
        needs_user_confirmation INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memories_user_active ON memories(user_id, deleted_at, created_at);

      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        model TEXT NOT NULL,
        thinking_type TEXT,
        prompt_hash TEXT,
        retrieved_memory_ids_json TEXT NOT NULL,
        tool_calls_json TEXT NOT NULL,
        first_token_latency INTEGER,
        total_latency INTEGER NOT NULL,
        usage_json TEXT NOT NULL,
        safety_flags_json TEXT NOT NULL,
        error_code TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_logs_request ON audit_logs(request_id);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_user_created ON audit_logs(user_id, created_at);
    `);
  }
}

function rowToMemory(row: any): StoredMemory {
  return {
    id: row.id,
    user_id: row.user_id,
    memory_type: row.memory_type,
    content: row.content,
    confidence: Number(row.confidence),
    sensitivity: row.sensitivity,
    source_message_id: row.source_message_id,
    user_confirmed: Boolean(row.user_confirmed),
    should_store: Boolean(row.should_store),
    needs_user_confirmation: Boolean(row.needs_user_confirmation),
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at ?? undefined,
  };
}

export function defaultStateDbPath(): string {
  return process.env.FLOWSKY_STATE_DB ?? resolve(process.cwd(), ".flowsky", "state.db");
}

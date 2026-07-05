import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defaultLocalDbPath, defaultLocalProfileId } from "../local/paths.ts";
import { DatabaseSync } from "node:sqlite";
import type { EmotionalState, EmotionalSupportNeed, LLMMessage, LocalChatMessage, LocalDataExport, LocalDataImportResult, LocalSession, MemoryCandidate, MemoryType, RelationshipStage, RelationshipState, StoredMemory, ToolCallRecord, UserMood, UserSettings } from "../types.ts";
import { randomId, nowIso } from "../util.ts";
import type { MemoryStoreLike } from "../memory/MemoryStore.ts";
import { DEFAULT_USER_SETTINGS, type SettingsStoreLike } from "../tools/tools/settings_tools.ts";
import type { RequestLogEntry } from "../observability/RequestLogger.ts";

const RELATIONSHIP_STAGES = new Set<RelationshipStage>([
  "stranger",
  "familiar",
  "close",
  "friendly_romantic",
  "romantic_light",
  "romantic_stable",
]);

const MEMORY_TYPES = new Set<MemoryType>([
  "session_memory",
  "profile_memory",
  "preference_memory",
  "episodic_memory",
  "relationship_memory",
  "sensitive_memory",
]);
const MEMORY_SENSITIVITIES = new Set(["low", "medium", "high"]);
const MESSAGE_ROLES = new Set(["user", "assistant", "tool", "system"]);
const USER_MOODS = new Set<UserMood>(["neutral", "tired", "sad", "anxious", "happy", "angry", "lonely"]);
const EMOTIONAL_SUPPORT_NEEDS = new Set<EmotionalSupportNeed>(["listening", "comfort", "encouragement", "celebration", "space"]);
const USER_SETTING_KEYS = new Set<keyof UserSettings>([
  "memory_enabled",
  "proactive_enabled",
  "romance_realism_level",
  "voice_enabled",
  "avatar_enabled",
  "preferred_name",
  "quiet_hours",
  "adult_romance_enabled",
]);

const MIGRATIONS = [
  {
    version: 1,
    name: "core_settings_memories_audit",
    sql: `
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
    `,
  },
  {
    version: 2,
    name: "sessions_relationships_tool_calls",
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user_updated ON sessions(user_id, updated_at);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        emotion TEXT,
        avatar_action TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);

      CREATE TABLE IF NOT EXISTS relationship_states (
        user_id TEXT PRIMARY KEY,
        stage TEXT NOT NULL,
        intimacy_level INTEGER NOT NULL,
        trust_level INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        allowed INTEGER NOT NULL,
        result_summary TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tool_calls_request ON tool_calls(request_id);
    `,
  },
  {
    version: 3,
    name: "local_profiles_and_local_audit_view",
    sql: `
      CREATE TABLE IF NOT EXISTS local_profiles (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT OR IGNORE INTO local_profiles (id, display_name, created_at, updated_at)
      VALUES ('default', '本地用户', datetime('now'), datetime('now'));

      CREATE VIEW IF NOT EXISTS local_audit_logs AS SELECT * FROM audit_logs;
    `,
  },
  {
    version: 4,
    name: "session_titles_and_message_indexes",
    sql: `
      ALTER TABLE sessions ADD COLUMN title TEXT;
      CREATE INDEX IF NOT EXISTS idx_messages_user_session_created ON messages(user_id, session_id, created_at);
    `,
  },
  {
    version: 5,
    name: "emotional_state",
    sql: `
      CREATE TABLE IF NOT EXISTS emotional_states (
        user_id TEXT PRIMARY KEY,
        mood TEXT NOT NULL,
        intensity INTEGER NOT NULL,
        valence INTEGER NOT NULL,
        support_need TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        source_message_id TEXT
      );
    `,
  },
] as const;

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

  createSession(userId: string, options: { id?: string; title?: string } = {}): LocalSession {
    const now = nowIso();
    const id = options.id ?? randomId("sess");
    const dbId = scopedSessionId(userId, id);
    const title = sanitizeTitle(options.title) ?? "新会话";
    this.db
      .prepare(`INSERT INTO sessions (id, user_id, created_at, updated_at, status, title)
        VALUES (?, ?, ?, ?, 'active', ?)
        ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`)
      .run(dbId, userId, now, now, title);
    return this.getSession(userId, id)!;
  }

  listSessions(userId: string, limit = 50, includeArchived = false): LocalSession[] {
    const rows = this.db
      .prepare(`SELECT s.*,
          COUNT(m.id) AS message_count,
          (SELECT content FROM messages m2 WHERE m2.user_id = s.user_id AND m2.session_id = s.id ORDER BY m2.created_at DESC, m2.rowid DESC LIMIT 1) AS last_message_preview
        FROM sessions s
        LEFT JOIN messages m ON m.user_id = s.user_id AND m.session_id = s.id
        WHERE s.user_id = ? AND (? = 1 OR s.status = 'active')
        GROUP BY s.id
        ORDER BY s.updated_at DESC
        LIMIT ?`)
      .all(userId, includeArchived ? 1 : 0, limit);
    return rows.map(rowToSession);
  }

  getSession(userId: string, sessionId: string): LocalSession | null {
    const row = this.db
      .prepare(`SELECT s.*,
          COUNT(m.id) AS message_count,
          (SELECT content FROM messages m2 WHERE m2.user_id = s.user_id AND m2.session_id = s.id ORDER BY m2.created_at DESC, m2.rowid DESC LIMIT 1) AS last_message_preview
        FROM sessions s
        LEFT JOIN messages m ON m.user_id = s.user_id AND m.session_id = s.id
        WHERE s.user_id = ? AND s.id = ?
        GROUP BY s.id`)
      .get(userId, scopedSessionId(userId, sessionId));
    return row ? rowToSession(row) : null;
  }

  updateSession(userId: string, sessionId: string, patch: { title?: string; status?: "active" | "archived" }): LocalSession | null {
    const existing = this.getSession(userId, sessionId);
    if (!existing) return null;
    const title = patch.title === undefined ? existing.title : sanitizeTitle(patch.title);
    const status = patch.status ?? existing.status;
    if (status !== "active" && status !== "archived") throw new Error("bad_request");
    const now = nowIso();
    this.db
      .prepare("UPDATE sessions SET title = ?, status = ?, updated_at = ? WHERE user_id = ? AND id = ?")
      .run(title ?? null, status, now, userId, scopedSessionId(userId, sessionId));
    return this.getSession(userId, sessionId);
  }

  deleteSession(userId: string, sessionId: string): boolean {
    const result = this.db
      .prepare("UPDATE sessions SET status = 'archived', updated_at = ? WHERE user_id = ? AND id = ? AND status != 'archived'")
      .run(nowIso(), userId, scopedSessionId(userId, sessionId));
    return Number(result.changes ?? 0) > 0;
  }

  listSessionMessages(userId: string, sessionId: string, limit = 200): LocalChatMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages
        WHERE user_id = ? AND session_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(userId, scopedSessionId(userId, sessionId), limit);
    return rows.reverse().map(rowToMessage);
  }

  recentMessages(userId: string, sessionId: string, limit = 12): LLMMessage[] {
    const rows = this.db
      .prepare(`SELECT role, content FROM messages
        WHERE user_id = ? AND session_id = ? AND role IN ('user', 'assistant')
        ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(userId, scopedSessionId(userId, sessionId), limit) as Array<{ role: "user" | "assistant"; content: string }>;
    return rows.reverse().map((row) => ({ role: row.role, content: row.content }));
  }

  saveMessage(params: {
    id: string;
    session_id: string;
    user_id: string;
    role: "user" | "assistant";
    content: string;
    emotion?: string;
    avatar_action?: string;
  }): void {
    const now = nowIso();
    const dbSessionId = scopedSessionId(params.user_id, params.session_id);
    const title = params.role === "user" ? sanitizeTitle(params.content) : undefined;
    this.db
      .prepare(`INSERT INTO sessions (id, user_id, created_at, updated_at, status, title)
        VALUES (?, ?, ?, ?, 'active', ?)
        ON CONFLICT(id) DO UPDATE SET
          updated_at = excluded.updated_at,
          title = COALESCE(sessions.title, excluded.title)`)
      .run(dbSessionId, params.user_id, now, now, title ?? null);
    this.db
      .prepare(`INSERT INTO messages (id, session_id, user_id, role, content, emotion, avatar_action, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        params.id,
        dbSessionId,
        params.user_id,
        params.role,
        params.content,
        params.emotion ?? null,
        params.avatar_action ?? null,
        now,
      );
  }

  recordToolCall(record: ToolCallRecord): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO tool_calls (
        id, request_id, user_id, tool_name, arguments_json, allowed, result_summary, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        record.id,
        record.request_id,
        record.user_id,
        record.tool_name,
        JSON.stringify(record.arguments_json),
        record.allowed ? 1 : 0,
        record.result_summary ?? null,
        record.created_at,
      );
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
    const all = this.list(userId).filter(
      (memory) => memory.should_store && memory.user_confirmed && !memory.needs_user_confirmation,
    );
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

  confirm(
    userId: string,
    memoryId: string,
    patch: Partial<Pick<StoredMemory, "content" | "memory_type">> = {},
  ): StoredMemory | null {
    const existing = this.db
      .prepare("SELECT * FROM memories WHERE user_id = ? AND id = ? AND deleted_at IS NULL")
      .get(userId, memoryId) as any | undefined;
    if (!existing) return null;
    const now = nowIso();
    const content = patch.content ?? existing.content;
    const memoryType = patch.memory_type ?? existing.memory_type;
    this.db
      .prepare(`UPDATE memories SET content = ?, memory_type = ?, should_store = 1,
        user_confirmed = 1, needs_user_confirmation = 0, updated_at = ?
        WHERE user_id = ? AND id = ? AND deleted_at IS NULL`)
      .run(content, memoryType, now, userId, memoryId);
    return rowToMemory({ ...existing, content, memory_type: memoryType, should_store: 1, user_confirmed: 1, needs_user_confirmation: 0, updated_at: now });
  }

  reject(userId: string, memoryId: string): boolean {
    return this.delete(userId, memoryId);
  }

  updateMemory(
    userId: string,
    memoryId: string,
    patch: Partial<Pick<StoredMemory, "content" | "memory_type">>,
  ): StoredMemory | null {
    const existing = this.db
      .prepare("SELECT * FROM memories WHERE user_id = ? AND id = ? AND deleted_at IS NULL")
      .get(userId, memoryId) as any | undefined;
    if (!existing) return null;
    const now = nowIso();
    const content = patch.content ?? existing.content;
    const memoryType = patch.memory_type ?? existing.memory_type;
    this.db
      .prepare("UPDATE memories SET content = ?, memory_type = ?, updated_at = ? WHERE user_id = ? AND id = ? AND deleted_at IS NULL")
      .run(content, memoryType, now, userId, memoryId);
    return rowToMemory({ ...existing, content, memory_type: memoryType, updated_at: now });
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

  getRelationshipState(userId: string): RelationshipState | null {
    const row = this.db
      .prepare("SELECT stage, intimacy_level, trust_level FROM relationship_states WHERE user_id = ?")
      .get(userId) as any | undefined;
    if (!row) return null;
    return rowToRelationship(row);
  }

  saveRelationshipState(userId: string, relationship: RelationshipState): RelationshipState {
    const next = sanitizeRelationshipState(relationship);
    this.db
      .prepare(`INSERT INTO relationship_states (user_id, stage, intimacy_level, trust_level, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          stage = excluded.stage,
          intimacy_level = excluded.intimacy_level,
          trust_level = excluded.trust_level,
          updated_at = excluded.updated_at`)
      .run(userId, next.stage, next.intimacy_level, next.trust_level, nowIso());
    return next;
  }

  getEmotionalState(userId: string): EmotionalState | null {
    const row = this.db
      .prepare("SELECT mood, intensity, valence, support_need, updated_at, source_message_id FROM emotional_states WHERE user_id = ?")
      .get(userId) as any | undefined;
    return row ? rowToEmotionalState(row) : null;
  }

  saveEmotionalState(userId: string, emotionalState: EmotionalState): EmotionalState {
    const next = sanitizeEmotionalState(emotionalState);
    this.db
      .prepare(`INSERT INTO emotional_states (user_id, mood, intensity, valence, support_need, updated_at, source_message_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          mood = excluded.mood,
          intensity = excluded.intensity,
          valence = excluded.valence,
          support_need = excluded.support_need,
          updated_at = excluded.updated_at,
          source_message_id = excluded.source_message_id`)
      .run(userId, next.mood, next.intensity, next.valence, next.support_need, next.updated_at, next.source_message_id ?? null);
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

  exportLocalData(userId = defaultLocalProfileId()): LocalDataExport {
    const settings = this.get(userId);
    const memories = this.list(userId);
    const sessions = this.listSessions(userId, 500, true);
    const messages = (this.db
      .prepare("SELECT * FROM messages WHERE user_id = ? ORDER BY created_at ASC, rowid ASC")
      .all(userId) as any[]).map(rowToMessage);
    const relationship = this.getRelationshipState(userId);
    const emotionalState = this.getEmotionalState(userId);
    const toolCalls = (this.db
      .prepare("SELECT * FROM tool_calls WHERE user_id = ? ORDER BY created_at DESC")
      .all(userId) as any[]).map(rowToToolCall);
    const auditLogs = this.db
      .prepare(`SELECT request_id, model, thinking_type, first_token_latency, total_latency,
        usage_json, safety_flags_json, error_code, created_at
        FROM audit_logs WHERE user_id = ? ORDER BY created_at DESC`)
      .all(userId);
    return {
      exported_at: nowIso(),
      profile_id: userId,
      settings,
      memories,
      sessions,
      messages,
      relationship,
      emotional_state: emotionalState,
      tool_calls: toolCalls,
      local_audit_logs: auditLogs,
    };
  }

  importLocalData(userId = defaultLocalProfileId(), raw: unknown): LocalDataImportResult {
    const data = sanitizeLocalDataImport(raw);
    this.assertImportedDataSafe(userId, data);
    this.db.exec("BEGIN");
    try {
      this.deleteLocalRows(userId);
      this.ensureLocalProfile(userId);
      if (data.settings) {
        this.db
          .prepare(`INSERT INTO user_settings (user_id, settings_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`)
          .run(userId, JSON.stringify(data.settings), nowIso());
      }

      for (const memory of data.memories) {
        this.db
          .prepare(`INSERT INTO memories (
            id, user_id, memory_type, content, confidence, sensitivity,
            source_message_id, user_confirmed, should_store, needs_user_confirmation,
            created_at, updated_at, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            memory.id,
            userId,
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
      }

      const seenSessions = new Set<string>();
      for (const session of data.sessions) {
        this.insertImportedSession(userId, session);
        seenSessions.add(session.id);
      }

      for (const message of data.messages) {
        if (!seenSessions.has(message.session_id)) {
          this.insertImportedSession(userId, {
            id: message.session_id,
            user_id: userId,
            title: message.role === "user" ? sanitizeTitle(message.content) : undefined,
            created_at: message.created_at,
            updated_at: message.created_at,
            status: "active",
            message_count: 0,
          });
          seenSessions.add(message.session_id);
        }
        this.db
          .prepare(`INSERT INTO messages (id, session_id, user_id, role, content, emotion, avatar_action, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            message.id,
            scopedSessionId(userId, message.session_id),
            userId,
            message.role,
            message.content,
            message.emotion ?? null,
            message.avatar_action ?? null,
            message.created_at,
          );
      }

      if (data.relationship) {
        this.db
          .prepare(`INSERT INTO relationship_states (user_id, stage, intimacy_level, trust_level, updated_at)
            VALUES (?, ?, ?, ?, ?)`)
          .run(userId, data.relationship.stage, data.relationship.intimacy_level, data.relationship.trust_level, nowIso());
      }

      if (data.emotional_state) {
        this.db
          .prepare(`INSERT INTO emotional_states (user_id, mood, intensity, valence, support_need, updated_at, source_message_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(
            userId,
            data.emotional_state.mood,
            data.emotional_state.intensity,
            data.emotional_state.valence,
            data.emotional_state.support_need,
            data.emotional_state.updated_at,
            data.emotional_state.source_message_id ?? null,
          );
      }

      for (const toolCall of data.tool_calls) {
        this.db
          .prepare(`INSERT INTO tool_calls (
            id, request_id, user_id, tool_name, arguments_json, allowed, result_summary, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            toolCall.id,
            toolCall.request_id,
            userId,
            toolCall.tool_name,
            JSON.stringify(toolCall.arguments_json),
            toolCall.allowed ? 1 : 0,
            toolCall.result_summary ?? null,
            toolCall.created_at,
          );
      }

      this.db.exec("COMMIT");
      return {
        imported_at: nowIso(),
        profile_id: userId,
        replaced: true,
        counts: {
          settings: data.settings ? 1 : 0,
          memories: data.memories.length,
          sessions: seenSessions.size,
          messages: data.messages.length,
          relationship: data.relationship ? 1 : 0,
          emotional_state: data.emotional_state ? 1 : 0,
          tool_calls: data.tool_calls.length,
        },
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  clearLocalData(userId = defaultLocalProfileId()): void {
    this.db.exec("BEGIN");
    try {
      this.deleteLocalRows(userId);
      this.ensureLocalProfile(userId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private assertImportedDataSafe(userId: string, data: SanitizedLocalDataImport): void {
    assertUniqueValues(data.memories.map((memory) => memory.id));
    assertUniqueValues(data.sessions.map((session) => session.id));
    assertUniqueValues(data.messages.map((message) => message.id));
    assertUniqueValues(data.tool_calls.map((toolCall) => toolCall.id));
    const sessionDbIds = [...new Set([
      ...data.sessions.map((session) => scopedSessionId(userId, session.id)),
      ...data.messages.map((message) => scopedSessionId(userId, message.session_id)),
    ])];
    this.assertIdsAvailable("sessions", sessionDbIds, userId);
    this.assertIdsAvailable("memories", data.memories.map((memory) => memory.id), userId);
    this.assertIdsAvailable("messages", data.messages.map((message) => message.id), userId);
    this.assertIdsAvailable("tool_calls", data.tool_calls.map((toolCall) => toolCall.id), userId);
  }

  private assertIdsAvailable(table: "sessions" | "memories" | "messages" | "tool_calls", ids: string[], userId: string): void {
    for (const id of ids) {
      const row = this.db.prepare(`SELECT user_id FROM ${table} WHERE id = ?`).get(id) as { user_id: string } | undefined;
      if (row && row.user_id !== userId) throw new Error("bad_request");
    }
  }

  private deleteLocalRows(userId: string): void {
    this.db.prepare("DELETE FROM tool_calls WHERE user_id = ?").run(userId);
    this.db.prepare("DELETE FROM relationship_states WHERE user_id = ?").run(userId);
    this.db.prepare("DELETE FROM emotional_states WHERE user_id = ?").run(userId);
    this.db.prepare("DELETE FROM messages WHERE user_id = ?").run(userId);
    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    this.db.prepare("DELETE FROM memories WHERE user_id = ?").run(userId);
    this.db.prepare("DELETE FROM audit_logs WHERE user_id = ?").run(userId);
    this.db.prepare("DELETE FROM user_settings WHERE user_id = ?").run(userId);
  }

  private ensureLocalProfile(userId: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO local_profiles (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(userId, "本地用户", nowIso(), nowIso());
  }

  private insertImportedSession(userId: string, session: LocalSession): void {
    this.db
      .prepare(`INSERT INTO sessions (id, user_id, created_at, updated_at, status, title)
        VALUES (?, ?, ?, ?, ?, ?)`)
      .run(
        scopedSessionId(userId, session.id),
        userId,
        session.created_at,
        session.updated_at,
        session.status,
        session.title ?? null,
      );
  }

  private init(): void {
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    for (const migration of MIGRATIONS) {
      const row = this.db
        .prepare("SELECT version FROM schema_migrations WHERE version = ?")
        .get(migration.version) as { version: number } | undefined;
      if (row) continue;
      this.db.exec("BEGIN");
      try {
        this.db.exec(migration.sql);
        this.db
          .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, nowIso());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }
}

function rowToRelationship(row: any): RelationshipState | null {
  if (!RELATIONSHIP_STAGES.has(row.stage)) return null;
  const intimacy = Number(row.intimacy_level);
  const trust = Number(row.trust_level);
  if (!Number.isFinite(intimacy) || !Number.isFinite(trust)) return null;
  if (intimacy < 0 || intimacy > 5 || trust < 0 || trust > 5) return null;
  return {
    stage: row.stage,
    intimacy_level: intimacy,
    trust_level: trust,
  };
}

function sanitizeRelationshipState(relationship: RelationshipState): RelationshipState {
  const normalized = rowToRelationship(relationship);
  if (!normalized) throw new Error("bad_request");
  return normalized;
}

function rowToEmotionalState(row: any): EmotionalState | null {
  const mood = row.mood;
  const supportNeed = row.support_need;
  const intensity = Number(row.intensity);
  const valence = Number(row.valence);
  if (!USER_MOODS.has(mood)) return null;
  if (!EMOTIONAL_SUPPORT_NEEDS.has(supportNeed)) return null;
  if (!Number.isInteger(intensity) || intensity < 0 || intensity > 5) return null;
  if (![-2, -1, 0, 1, 2].includes(valence)) return null;
  if (typeof row.updated_at !== "string") return null;
  return {
    mood,
    intensity,
    valence: valence as EmotionalState["valence"],
    support_need: supportNeed,
    updated_at: row.updated_at,
    source_message_id: row.source_message_id ?? undefined,
  };
}

function sanitizeEmotionalState(emotionalState: EmotionalState): EmotionalState {
  const normalized = rowToEmotionalState(emotionalState);
  if (!normalized) throw new Error("bad_request");
  return normalized;
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

function rowToSession(row: any): LocalSession {
  return {
    id: unscopedSessionId(row.user_id, row.id),
    user_id: row.user_id,
    title: row.title ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    status: row.status === "archived" ? "archived" : "active",
    last_message_preview: row.last_message_preview ? String(row.last_message_preview).slice(0, 120) : undefined,
    message_count: Number(row.message_count ?? 0),
  };
}

function rowToMessage(row: any): LocalChatMessage {
  return {
    id: row.id,
    session_id: unscopedSessionId(row.user_id, row.session_id),
    user_id: row.user_id,
    role: row.role,
    content: row.content,
    emotion: row.emotion ?? undefined,
    avatar_action: row.avatar_action ?? undefined,
    created_at: row.created_at,
  };
}

function rowToToolCall(row: any): ToolCallRecord {
  return {
    id: row.id,
    request_id: row.request_id,
    user_id: row.user_id,
    tool_name: row.tool_name,
    arguments_json: parseArgumentsJson(row.arguments_json),
    allowed: Boolean(row.allowed),
    result_summary: row.result_summary ?? undefined,
    created_at: row.created_at,
  };
}

interface SanitizedLocalDataImport {
  settings?: UserSettings;
  memories: StoredMemory[];
  sessions: LocalSession[];
  messages: LocalChatMessage[];
  relationship: RelationshipState | null;
  emotional_state: EmotionalState | null;
  tool_calls: ToolCallRecord[];
}

function sanitizeLocalDataImport(raw: unknown): SanitizedLocalDataImport {
  if (!isPlainObject(raw)) throw new Error("bad_request");
  return {
    settings: raw.settings === undefined ? undefined : sanitizeImportedSettings(raw.settings),
    memories: sanitizeImportedArray(raw.memories, sanitizeImportedMemory),
    sessions: sanitizeImportedArray(raw.sessions, sanitizeImportedSession),
    messages: sanitizeImportedArray(raw.messages, sanitizeImportedMessage),
    relationship: raw.relationship === undefined || raw.relationship === null ? null : sanitizeRelationshipState(raw.relationship as RelationshipState),
    emotional_state: raw.emotional_state === undefined || raw.emotional_state === null ? null : sanitizeEmotionalState(raw.emotional_state as EmotionalState),
    tool_calls: sanitizeImportedArray(raw.tool_calls, sanitizeImportedToolCall),
  };
}

function sanitizeImportedArray<T>(value: unknown, mapper: (value: unknown) => T): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("bad_request");
  return value.map(mapper);
}

function sanitizeImportedSettings(raw: unknown): UserSettings {
  if (!isPlainObject(raw)) throw new Error("bad_request");
  const settings: Partial<UserSettings> = {};
  for (const key of Object.keys(raw)) {
    if (!USER_SETTING_KEYS.has(key as keyof UserSettings)) throw new Error("bad_request");
  }
  for (const key of ["memory_enabled", "proactive_enabled", "voice_enabled", "avatar_enabled", "adult_romance_enabled"] as const) {
    if (key in raw) {
      if (typeof raw[key] !== "boolean") throw new Error("bad_request");
      settings[key] = raw[key];
    }
  }
  if ("romance_realism_level" in raw) {
    if (typeof raw.romance_realism_level !== "number" || !Number.isFinite(raw.romance_realism_level)) throw new Error("bad_request");
    if (raw.romance_realism_level < 0 || raw.romance_realism_level > 2) throw new Error("bad_request");
    settings.romance_realism_level = raw.romance_realism_level;
  }
  if ("preferred_name" in raw) {
    if (typeof raw.preferred_name !== "string" || raw.preferred_name.length > 80) throw new Error("bad_request");
    settings.preferred_name = raw.preferred_name.trim() || undefined;
  }
  if ("quiet_hours" in raw) {
    if (!Array.isArray(raw.quiet_hours) || raw.quiet_hours.some((value) => typeof value !== "string" || value.length > 20)) throw new Error("bad_request");
    settings.quiet_hours = raw.quiet_hours;
  }
  return { ...DEFAULT_USER_SETTINGS, ...settings };
}

function sanitizeImportedMemory(raw: unknown): StoredMemory {
  if (!isPlainObject(raw)) throw new Error("bad_request");
  const memoryType = requiredString(raw.memory_type, 80);
  const sensitivity = requiredString(raw.sensitivity, 20);
  const confidence = requiredNumber(raw.confidence);
  if (!MEMORY_TYPES.has(memoryType as MemoryType)) throw new Error("bad_request");
  if (!MEMORY_SENSITIVITIES.has(sensitivity)) throw new Error("bad_request");
  if (confidence < 0 || confidence > 1) throw new Error("bad_request");
  return {
    id: requiredString(raw.id, 120),
    user_id: "",
    memory_type: memoryType as MemoryType,
    content: requiredString(raw.content, 2_000),
    confidence,
    sensitivity: sensitivity as StoredMemory["sensitivity"],
    source_message_id: requiredString(raw.source_message_id, 120),
    user_confirmed: requiredBoolean(raw.user_confirmed),
    should_store: requiredBoolean(raw.should_store),
    needs_user_confirmation: requiredBoolean(raw.needs_user_confirmation),
    created_at: optionalString(raw.created_at, 80) ?? nowIso(),
    updated_at: optionalString(raw.updated_at, 80) ?? nowIso(),
    deleted_at: optionalString(raw.deleted_at, 80),
  };
}

function sanitizeImportedSession(raw: unknown): LocalSession {
  if (!isPlainObject(raw)) throw new Error("bad_request");
  const sourceUserId = optionalString(raw.user_id, 120);
  const id = normalizeImportedSessionId(requiredString(raw.id, 120), sourceUserId);
  const status = raw.status === "archived" ? "archived" : raw.status === "active" || raw.status === undefined ? "active" : undefined;
  if (!status) throw new Error("bad_request");
  return {
    id,
    user_id: "",
    title: sanitizeTitle(optionalString(raw.title, 120)),
    created_at: optionalString(raw.created_at, 80) ?? nowIso(),
    updated_at: optionalString(raw.updated_at, 80) ?? nowIso(),
    status,
    message_count: 0,
  };
}

function sanitizeImportedMessage(raw: unknown): LocalChatMessage {
  if (!isPlainObject(raw)) throw new Error("bad_request");
  const sourceUserId = optionalString(raw.user_id, 120);
  const sessionId = normalizeImportedSessionId(requiredString(raw.session_id, 120), sourceUserId);
  const role = requiredString(raw.role, 20);
  if (!MESSAGE_ROLES.has(role)) throw new Error("bad_request");
  return {
    id: requiredString(raw.id, 120),
    session_id: sessionId,
    user_id: "",
    role: role as LocalChatMessage["role"],
    content: requiredString(raw.content, 20_000),
    emotion: optionalString(raw.emotion, 80),
    avatar_action: optionalString(raw.avatar_action, 80),
    created_at: optionalString(raw.created_at, 80) ?? nowIso(),
  };
}

function sanitizeImportedToolCall(raw: unknown): ToolCallRecord {
  if (!isPlainObject(raw)) throw new Error("bad_request");
  return {
    id: requiredString(raw.id, 120),
    request_id: requiredString(raw.request_id, 120),
    user_id: "",
    tool_name: requiredString(raw.tool_name, 120),
    arguments_json: parseArgumentsJson(raw.arguments_json),
    allowed: requiredBoolean(raw.allowed),
    result_summary: optionalString(raw.result_summary, 500),
    created_at: optionalString(raw.created_at, 80) ?? nowIso(),
  };
}

function parseArgumentsJson(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return parseArgumentsJson(JSON.parse(value));
    } catch {
      throw new Error("bad_request");
    }
  }
  if (!isPlainObject(value)) throw new Error("bad_request");
  return value;
}

function requiredString(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) throw new Error("bad_request");
  return value;
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > maxLength) throw new Error("bad_request");
  return value;
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (value === 0 || value === 1) return Boolean(value);
  throw new Error("bad_request");
}

function requiredNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("bad_request");
  return value;
}

function normalizeImportedSessionId(sessionId: string, sourceUserId?: string): string {
  const logicalId = sourceUserId ? unscopedSessionId(sourceUserId, sessionId) : sessionId;
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(logicalId)) throw new Error("bad_request");
  return logicalId;
}

function assertUniqueValues(values: string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error("bad_request");
    seen.add(value);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sanitizeTitle(title: string | undefined): string | undefined {
  const trimmed = title?.trim().replace(/\s+/g, " ").slice(0, 80);
  return trimmed || undefined;
}

function scopedSessionId(userId: string, sessionId: string): string {
  if (sessionId.startsWith(`${userId}::`)) return sessionId;
  return `${userId}::${sessionId}`;
}

function unscopedSessionId(userId: string, sessionId: string): string {
  const prefix = `${userId}::`;
  return sessionId.startsWith(prefix) ? sessionId.slice(prefix.length) : sessionId;
}

export function defaultStateDbPath(): string {
  return defaultLocalDbPath();
}

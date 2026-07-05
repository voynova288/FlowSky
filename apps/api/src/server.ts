import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AgentGateway,
  createDefaultAgentGateway,
  defaultLocalDataDir,
  defaultLocalProfileId,
  LocalCharacterStore,
  modelConfigForMode,
  resolveProviderConfig,
  SqliteStateStore,
  validateCharacterCard,
  type CharacterCard,
  type ChatRequest,
  normalizeProviderName,
  type LLMProviderName,
  type MemoryType,
  type StoredMemory,
  type StreamEvent,
  type UserSettings,
} from "../../../packages/agent-gateway/src/index.ts";
import { authenticateLocal, loadOrCreateLocalToken, localTokenRequired, writeUnauthorized } from "./auth.ts";
import { loadLocalEnv } from "./localEnv.ts";

loadLocalEnv();

const WEB_INDEX = new URL("../../web/index.html", import.meta.url);
const MAX_BODY_BYTES = Number(process.env.LIUKONG_MAX_BODY_BYTES ?? process.env.FLOWSKY_MAX_BODY_BYTES ?? 1_000_000);
const MEMORY_TYPES = new Set<MemoryType>([
  "session_memory",
  "profile_memory",
  "preference_memory",
  "episodic_memory",
  "relationship_memory",
  "sensitive_memory",
]);
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


type LocalChatRequestBody = Omit<ChatRequest, "user_id"> & Partial<Pick<ChatRequest, "user_id">>;

export interface ProviderSelection {
  providerName: LLMProviderName;
  apiKey: string;
  modelOverride?: string;
}

const CHAT_MODES = new Set(["girlfriend_chat", "girlfriend_complex", "memory_extraction", "safety_rewrite"]);
const CHAT_BODY_KEYS = new Set(["request_id", "user_id", "profile_id", "session_id", "input", "mode", "client_context"]);
const CHAT_INPUT_KEYS = new Set(["type", "text"]);
const CLIENT_CONTEXT_KEYS = new Set(["timezone", "voice_enabled", "avatar_enabled"]);

export interface CreateApiServerOptions {
  gateway?: AgentGateway;
  gatewayFactory?: (apiKey: string, selection?: ProviderSelection) => AgentGateway;
  stateStore?: SqliteStateStore;
  characterStore?: LocalCharacterStore;
  localToken?: string;
  requireLocalToken?: boolean;
  fetchFn?: typeof fetch;
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  let raw = "";
  let bytes = 0;
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk as Buffer);
    if (bytes > MAX_BODY_BYTES) throw new Error("request_body_too_large");
    raw += chunk;
  }
  if (!raw.trim()) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error("bad_json");
  }
}

function sseWrite(res: ServerResponse, event: StreamEvent): void {
  res.write(`event: ${event.event}\n`);
  res.write(`data: ${JSON.stringify(event.data)}\n\n`);
}

function requestedProfileId(url: URL, body?: Partial<ChatRequest>): string | null {
  return body?.profile_id ?? body?.user_id ?? url.searchParams.get("profile_id") ?? url.searchParams.get("user_id");
}

function sanitizeChatRequest(raw: unknown): LocalChatRequestBody {
  if (!isObject(raw)) throw new Error("bad_request");
  for (const key of Object.keys(raw)) {
    if (!CHAT_BODY_KEYS.has(key)) throw new Error("bad_request");
  }
  if (typeof raw.session_id !== "string" || raw.session_id.trim().length === 0 || raw.session_id.length > 120) throw new Error("bad_request");
  if (!isObject(raw.input)) throw new Error("bad_request");
  for (const key of Object.keys(raw.input)) {
    if (!CHAT_INPUT_KEYS.has(key)) throw new Error("bad_request");
  }
  if (raw.input.type !== "text" || typeof raw.input.text !== "string" || raw.input.text.trim().length === 0 || raw.input.text.length > 20_000) throw new Error("bad_request");
  const body: LocalChatRequestBody = {
    session_id: raw.session_id,
    input: { type: "text", text: raw.input.text },
  };
  for (const key of ["request_id", "user_id", "profile_id"] as const) {
    if (key in raw) {
      if (typeof raw[key] !== "string" || raw[key].length > 120) throw new Error("bad_request");
      body[key] = raw[key];
    }
  }
  if ("mode" in raw) {
    if (typeof raw.mode !== "string" || !CHAT_MODES.has(raw.mode)) throw new Error("bad_request");
    body.mode = raw.mode as LocalChatRequestBody["mode"];
  }
  if ("client_context" in raw) {
    if (!isObject(raw.client_context)) throw new Error("bad_request");
    for (const key of Object.keys(raw.client_context)) {
      if (!CLIENT_CONTEXT_KEYS.has(key)) throw new Error("bad_request");
    }
    const context: NonNullable<LocalChatRequestBody["client_context"]> = {};
    if ("timezone" in raw.client_context) {
      if (typeof raw.client_context.timezone !== "string" || raw.client_context.timezone.length > 120) throw new Error("bad_request");
      context.timezone = raw.client_context.timezone;
    }
    for (const key of ["voice_enabled", "avatar_enabled"] as const) {
      if (key in raw.client_context) {
        if (typeof raw.client_context[key] !== "boolean") throw new Error("bad_request");
        context[key] = raw.client_context[key];
      }
    }
    body.client_context = context;
  }
  return body;
}

function sanitizeMemoryPatch(raw: unknown): { content?: string; memory_type?: MemoryType } {
  if (!isObject(raw)) throw new Error("bad_request");
  const patch: { content?: string; memory_type?: MemoryType } = {};
  for (const key of Object.keys(raw)) {
    if (key !== "content" && key !== "memory_type") throw new Error("bad_request");
  }
  if ("content" in raw) {
    if (typeof raw.content !== "string" || raw.content.length > 2_000) throw new Error("bad_request");
    patch.content = raw.content.trim();
  }
  if ("memory_type" in raw) {
    if (typeof raw.memory_type !== "string" || !MEMORY_TYPES.has(raw.memory_type as MemoryType)) throw new Error("bad_request");
    patch.memory_type = raw.memory_type as MemoryType;
  }
  return patch;
}

function sanitizeManualMemoryBody(raw: unknown): { content: string; memory_type: MemoryType; sensitivity?: StoredMemory["sensitivity"] } {
  if (!isObject(raw)) throw new Error("bad_request");
  const allowed = new Set(["content", "memory_type", "sensitivity"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error("bad_request");
  }
  if (typeof raw.content !== "string" || raw.content.trim().length === 0 || raw.content.length > 2_000) throw new Error("bad_request");
  let memoryType: MemoryType = "preference_memory";
  if ("memory_type" in raw) {
    if (typeof raw.memory_type !== "string" || !MEMORY_TYPES.has(raw.memory_type as MemoryType)) throw new Error("bad_request");
    memoryType = raw.memory_type as MemoryType;
  }
  let sensitivity: StoredMemory["sensitivity"] | undefined;
  if ("sensitivity" in raw) {
    if (raw.sensitivity !== "low" && raw.sensitivity !== "medium" && raw.sensitivity !== "high") throw new Error("bad_request");
    sensitivity = raw.sensitivity;
  }
  return { content: raw.content.trim(), memory_type: memoryType, sensitivity };
}

function filterMemoriesForQuery(memories: StoredMemory[], params: URLSearchParams): StoredMemory[] {
  const query = (params.get("q") ?? "").trim().toLowerCase();
  const type = params.get("type") ?? "all";
  const status = params.get("status") ?? "all";
  const limit = Math.max(1, Math.min(500, Number(params.get("limit") ?? 200) || 200));
  if (type !== "all" && !MEMORY_TYPES.has(type as MemoryType)) throw new Error("bad_request");
  if (!["all", "confirmed", "pending", "sensitive"].includes(status)) throw new Error("bad_request");
  return memories
    .filter((memory) => type === "all" || memory.memory_type === type)
    .filter((memory) => status === "all" || memoryStatus(memory) === status || (status === "sensitive" && (memory.memory_type === "sensitive_memory" || memory.sensitivity === "high")))
    .filter((memory) => !query || `${memory.content} ${memory.memory_type}`.toLowerCase().includes(query))
    .slice(0, limit);
}

function memoryStatus(memory: StoredMemory): "confirmed" | "pending" | "sensitive" {
  if (memory.memory_type === "sensitive_memory" || memory.sensitivity === "high") return "sensitive";
  if (memory.should_store && memory.user_confirmed && !memory.needs_user_confirmation) return "confirmed";
  return "pending";
}

function memorySummary(memories: StoredMemory[]): Record<string, unknown> {
  const byType: Record<string, number> = {};
  let confirmed = 0;
  let pending = 0;
  let sensitive = 0;
  for (const memory of memories) {
    byType[memory.memory_type] = (byType[memory.memory_type] ?? 0) + 1;
    const status = memoryStatus(memory);
    if (status === "confirmed") confirmed += 1;
    else if (status === "sensitive") sensitive += 1;
    else pending += 1;
  }
  return { total: memories.length, confirmed, pending, sensitive, by_type: byType };
}

function sanitizeSettingsPatch(raw: unknown): Partial<UserSettings> {
  if (!isObject(raw)) throw new Error("bad_request");
  const patch: Partial<UserSettings> = {};
  for (const key of Object.keys(raw)) {
    if (!USER_SETTING_KEYS.has(key as keyof UserSettings)) throw new Error("bad_request");
  }
  for (const key of ["memory_enabled", "proactive_enabled", "voice_enabled", "avatar_enabled", "adult_romance_enabled"] as const) {
    if (key in raw) {
      if (typeof raw[key] !== "boolean") throw new Error("bad_request");
      patch[key] = raw[key];
    }
  }
  if ("romance_realism_level" in raw) {
    if (typeof raw.romance_realism_level !== "number" || !Number.isFinite(raw.romance_realism_level)) throw new Error("bad_request");
    if (raw.romance_realism_level < 0 || raw.romance_realism_level > 2) throw new Error("bad_request");
    patch.romance_realism_level = raw.romance_realism_level;
  }
  if ("preferred_name" in raw) {
    if (typeof raw.preferred_name !== "string" || raw.preferred_name.length > 80) throw new Error("bad_request");
    patch.preferred_name = raw.preferred_name.trim() || undefined;
  }
  if ("quiet_hours" in raw) {
    if (!Array.isArray(raw.quiet_hours) || raw.quiet_hours.some((value) => typeof value !== "string" || value.length > 20)) throw new Error("bad_request");
    patch.quiet_hours = raw.quiet_hours;
  }
  return patch;
}

function sanitizeSessionPatch(raw: unknown): { title?: string; status?: "active" | "archived" } {
  if (!isObject(raw)) throw new Error("bad_request");
  const patch: { title?: string; status?: "active" | "archived" } = {};
  for (const key of Object.keys(raw)) {
    if (key !== "title" && key !== "status") throw new Error("bad_request");
  }
  if ("title" in raw) {
    if (typeof raw.title !== "string" || raw.title.length > 120) throw new Error("bad_request");
    patch.title = raw.title.trim().slice(0, 80);
  }
  if ("status" in raw) {
    if (raw.status !== "active" && raw.status !== "archived") throw new Error("bad_request");
    patch.status = raw.status;
  }
  return patch;
}

function sanitizeSessionId(raw: string): string {
  const id = decodeURIComponent(raw).trim();
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(id)) throw new Error("bad_request");
  return id;
}

function providerSelection(req: IncomingMessage): ProviderSelection {
  const providerHeader = firstHeader(req.headers["x-liukong-provider"] ?? req.headers["x-flowsky-provider"]);
  const providerName = normalizeProviderName(providerHeader);
  const headerKey = firstHeader(req.headers["x-liukong-api-key"] ?? req.headers["x-flowsky-api-key"]);
  const modelOverride = providerName === "ollama"
    ? sanitizeModelOverride(firstHeader(req.headers["x-liukong-model"] ?? req.headers["x-liukong-ollama-model"]))
    : undefined;
  const envKey = providerName === "openai"
    ? process.env.LIUKONG_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY
    : providerName === "ollama"
      ? process.env.LIUKONG_OLLAMA_API_KEY ?? process.env.OLLAMA_API_KEY
      : process.env.DEEPSEEK_API_KEY;
  return { providerName, apiKey: (headerKey || envKey || "").trim(), modelOverride };
}

function sanitizeModelOverride(raw: string | undefined): string | undefined {
  const model = raw?.trim();
  if (!model) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/+-]{0,119}$/.test(model)) throw new Error("bad_request");
  return model;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function providerRequiresApiKey(providerName: LLMProviderName): boolean {
  return providerName !== "ollama";
}

async function inspectOllama(fetchFn: typeof fetch = fetch) {
  const baseUrl = resolveProviderConfig({ providerName: "ollama" }).baseUrl;
  const configuredModel = modelConfigForMode("girlfriend_chat", "ollama").model;
  try {
    const models = await listOllamaModels(baseUrl, fetchFn);
    return {
      ok: true,
      provider: "ollama",
      running: true,
      base_url: baseUrl,
      configured_model: configuredModel,
      configured_model_available: models.includes(configuredModel),
      models,
      pull_command: models.includes(configuredModel) ? undefined : `ollama pull ${configuredModel}`,
      install_hint: models.length ? undefined : "Ollama 已运行，但还没有本地模型。先执行 pull_command 拉取默认模型。",
    };
  } catch (error) {
    return {
      ok: false,
      provider: "ollama",
      running: false,
      base_url: baseUrl,
      configured_model: configuredModel,
      configured_model_available: false,
      models: [],
      pull_command: `ollama pull ${configuredModel}`,
      install_hint: "请先安装并启动 Ollama：ollama serve；然后执行 pull_command 拉取默认模型。",
      error: sanitizeOllamaStatusError(error),
    };
  }
}

async function listOllamaModels(baseUrl: string, fetchFn: typeof fetch): Promise<string[]> {
  try {
    const jsonBody = await fetchJsonWithTimeout(`${baseUrl.replace(/\/$/, "")}/models`, fetchFn);
    const models = parseOpenAIModelList(jsonBody);
    if (models.length > 0) return models;
  } catch {
    // Older Ollama builds may not expose /v1/models; fall back to native tags.
  }
  const nativeBaseUrl = baseUrl.replace(/\/v1\/?$/, "");
  const jsonBody = await fetchJsonWithTimeout(`${nativeBaseUrl.replace(/\/$/, "")}/api/tags`, fetchFn);
  return parseOllamaTagList(jsonBody);
}

async function fetchJsonWithTimeout(url: string, fetchFn: typeof fetch): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetchFn(url, { headers: { accept: "application/json" }, signal: controller.signal });
    if (!response.ok) throw new Error(`http_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function parseOpenAIModelList(raw: any): string[] {
  if (!Array.isArray(raw?.data)) return [];
  return raw.data.map((model: any) => String(model?.id ?? "").trim()).filter(Boolean).sort();
}

function parseOllamaTagList(raw: any): string[] {
  if (!Array.isArray(raw?.models)) return [];
  return raw.models.map((model: any) => String(model?.name ?? "").trim()).filter(Boolean).sort();
}

function sanitizeOllamaStatusError(error: unknown): string {
  if (error instanceof Error) return error.name === "AbortError" ? "timeout" : error.message.slice(0, 160);
  return String(error).slice(0, 160);
}

function importedCharacterCard(raw: unknown): CharacterCard | undefined {
  if (!isObject(raw)) return undefined;
  if ("character" in raw) return validateCharacterCard(raw.character);
  if (isObject(raw.characters) && "default_girlfriend" in raw.characters) return validateCharacterCard(raw.characters.default_girlfriend);
  return undefined;
}

function statusForError(code: string): number {
  if (code === "request_body_too_large") return 413;
  if (code === "bad_json" || code === "bad_request" || code === "bad_character_card" || code === "missing_provider_key" || code === "bad_provider") return 400;
  return 500;
}

function withLocalToken(indexHtml: string, localToken: string, profileId: string): string {
  const boot = `<script>window.__LIUKONG_LOCAL__=${JSON.stringify({ localToken, profileId })};</script>`;
  return indexHtml.replace("</head>", `${boot}\n  </head>`);
}

export function createApiServer(input: AgentGateway | CreateApiServerOptions = {}) {
  const options: CreateApiServerOptions = input instanceof AgentGateway ? { gateway: input } : input;
  const stateStore = options.stateStore ?? (options.gateway ? undefined : new SqliteStateStore());
  const baseGateway = options.gateway ?? createDefaultAgentGateway({ stateStore, allowMissingApiKey: true, fetchFn: options.fetchFn });
  let characterStore = options.characterStore;
  const requireToken = options.requireLocalToken ?? localTokenRequired();
  const localToken = options.localToken ?? (requireToken ? loadOrCreateLocalToken(defaultLocalDataDir()) : "test-local-token");
  const defaultProfileId = defaultLocalProfileId();

  function auth(req: IncomingMessage, url: URL, body?: Partial<ChatRequest>) {
    return authenticateLocal(req, {
      localToken,
      requireLocalToken: requireToken,
      requestedProfileId: requestedProfileId(url, body),
    });
  }

  function localCharacterStore(): LocalCharacterStore {
    characterStore ??= new LocalCharacterStore();
    return characterStore;
  }

  function gatewayForChat(selection: ProviderSelection): AgentGateway {
    if (options.gateway) return options.gateway;
    if (options.gatewayFactory) return options.gatewayFactory(selection.apiKey, selection);
    if (!stateStore) return baseGateway;
    return createDefaultAgentGateway({ apiKey: selection.apiKey, providerName: selection.providerName, modelOverride: selection.modelOverride, stateStore, fetchFn: options.fetchFn });
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (req.method === "GET" && url.pathname === "/") {
        return html(res, 200, withLocalToken(readFileSync(WEB_INDEX, "utf8"), localToken, defaultProfileId));
      }

      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, { ok: true, mode: "local", profile_id: defaultProfileId });
      }

      if (req.method === "GET" && url.pathname === "/providers/ollama/status") {
        const localAuth = auth(req, url);
        if (!localAuth) return writeUnauthorized(res);
        return json(res, 200, await inspectOllama(options.fetchFn));
      }

      if (req.method === "GET" && url.pathname === "/character") {
        const localAuth = auth(req, url);
        if (!localAuth) return writeUnauthorized(res);
        return json(res, 200, { character: localCharacterStore().loadCharacter("default_girlfriend") });
      }

      if ((req.method === "PATCH" || req.method === "PUT") && url.pathname === "/character") {
        const localAuth = auth(req, url);
        if (!localAuth) return writeUnauthorized(res);
        const body = await readJson<{ character?: CharacterCard } | CharacterCard>(req);
        const rawCard = isObject(body) && "character" in body ? body.character : body;
        const character = localCharacterStore().saveCharacter("default_girlfriend", validateCharacterCard(rawCard));
        return json(res, 200, { character });
      }

      if (req.method === "POST" && url.pathname === "/character/reset") {
        const localAuth = auth(req, url);
        if (!localAuth) return writeUnauthorized(res);
        return json(res, 200, { character: localCharacterStore().resetCharacter("default_girlfriend") });
      }

      if (req.method === "GET" && url.pathname === "/sessions") {
        const localAuth = auth(req, url);
        if (!localAuth) return writeUnauthorized(res);
        if (!stateStore) return json(res, 501, { error: "local_store_unavailable" });
        const includeArchived = url.searchParams.get("include_archived") === "true";
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
        return json(res, 200, { sessions: stateStore.listSessions(localAuth.profileId, limit, includeArchived) });
      }

      if (req.method === "POST" && url.pathname === "/sessions") {
        const localAuth = auth(req, url);
        if (!localAuth) return writeUnauthorized(res);
        if (!stateStore) return json(res, 501, { error: "local_store_unavailable" });
        const body = await readJson<{ id?: string; title?: string }>(req);
        const session = stateStore.createSession(localAuth.profileId, {
          id: body.id ? sanitizeSessionId(body.id) : undefined,
          title: typeof body.title === "string" ? body.title : undefined,
        });
        return json(res, 200, { session });
      }

      const sessionMessagesMatch = url.pathname.match(/^\/sessions\/([^/]+)\/messages$/);
      if (req.method === "GET" && sessionMessagesMatch) {
        const localAuth = auth(req, url);
        if (!localAuth) return writeUnauthorized(res);
        if (!stateStore) return json(res, 501, { error: "local_store_unavailable" });
        const sessionId = sanitizeSessionId(sessionMessagesMatch[1]);
        if (!stateStore.getSession(localAuth.profileId, sessionId)) return json(res, 404, { error: "session_not_found" });
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 200)));
        return json(res, 200, { messages: stateStore.listSessionMessages(localAuth.profileId, sessionId, limit) });
      }

      const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
      if (req.method === "PATCH" && sessionMatch) {
        const localAuth = auth(req, url);
        if (!localAuth) return writeUnauthorized(res);
        if (!stateStore) return json(res, 501, { error: "local_store_unavailable" });
        const session = stateStore.updateSession(localAuth.profileId, sanitizeSessionId(sessionMatch[1]), sanitizeSessionPatch(await readJson<unknown>(req)));
        return json(res, session ? 200 : 404, session ? { session } : { error: "session_not_found" });
      }
      if (req.method === "DELETE" && sessionMatch) {
        const localAuth = auth(req, url);
        if (!localAuth) return writeUnauthorized(res);
        if (!stateStore) return json(res, 501, { error: "local_store_unavailable" });
        const deleted = stateStore.deleteSession(localAuth.profileId, sanitizeSessionId(sessionMatch[1]));
        return json(res, deleted ? 200 : 404, { deleted });
      }

      if (req.method === "POST" && url.pathname === "/chat") {
        const body = sanitizeChatRequest(await readJson<unknown>(req));
        const localAuth = auth(req, url, body);
        if (!localAuth) return writeUnauthorized(res);
        const selection = providerSelection(req);
        if (providerRequiresApiKey(selection.providerName) && !selection.apiKey && !options.gateway) throw new Error("missing_provider_key");
        const response = await gatewayForChat(selection).chat({ ...body, user_id: localAuth.profileId, profile_id: localAuth.profileId });
        return json(res, 200, response);
      }

      if (req.method === "POST" && url.pathname === "/chat/stream") {
        const body = sanitizeChatRequest(await readJson<unknown>(req));
        const localAuth = auth(req, url, body);
        if (!localAuth) return writeUnauthorized(res);
        const selection = providerSelection(req);
        if (providerRequiresApiKey(selection.providerName) && !selection.apiKey && !options.gateway) throw new Error("missing_provider_key");
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        for await (const event of gatewayForChat(selection).stream({ ...body, user_id: localAuth.profileId, profile_id: localAuth.profileId })) sseWrite(res, event);
        return res.end();
      }

      if (req.method === "GET" && url.pathname === "/local/export") {
        const localAuth = auth(req, url);
        if (!localAuth) return writeUnauthorized(res);
        if (!stateStore) return json(res, 501, { error: "local_store_unavailable" });
        return json(res, 200, {
          ...stateStore.exportLocalData(localAuth.profileId),
          character: localCharacterStore().loadCharacter("default_girlfriend"),
        });
      }

      if (req.method === "POST" && url.pathname === "/local/import") {
        const localAuth = auth(req, url);
        if (!localAuth) return writeUnauthorized(res);
        if (!stateStore) return json(res, 501, { error: "local_store_unavailable" });
        const body = await readJson<unknown>(req);
        const character = importedCharacterCard(body);
        const result = stateStore.importLocalData(localAuth.profileId, body);
        if (character) localCharacterStore().saveCharacter("default_girlfriend", character);
        return json(res, 200, { ok: true, ...result, character_imported: Boolean(character) });
      }

      if (req.method === "POST" && url.pathname === "/local/reset") {
        const localAuth = auth(req, url);
        if (!localAuth) return writeUnauthorized(res);
        if (!stateStore) return json(res, 501, { error: "local_store_unavailable" });
        stateStore.clearLocalData(localAuth.profileId);
        return json(res, 200, { ok: true });
      }

      if (req.method === "GET" && url.pathname === "/emotion") {
        const localAuth = auth(req, url);
        if (!localAuth) return writeUnauthorized(res);
        if (!stateStore) return json(res, 501, { error: "local_store_unavailable" });
        return json(res, 200, {
          emotional_state: stateStore.getEmotionalState(localAuth.profileId),
          relationship: stateStore.getRelationshipState(localAuth.profileId),
        });
      }

      if (req.method === "GET" && url.pathname === "/timers") {
        const localAuth = auth(req, url);
        if (!localAuth) return writeUnauthorized(res);
        if (!stateStore) return json(res, 501, { error: "local_store_unavailable" });
        return json(res, 200, { timers: stateStore.listLocalTimerStatuses(localAuth.profileId) });
      }

      const timerMatch = url.pathname.match(/^\/timers\/([^/]+)$/);
      if (req.method === "GET" && timerMatch) {
        const localAuth = auth(req, url);
        if (!localAuth) return writeUnauthorized(res);
        if (!stateStore) return json(res, 501, { error: "local_store_unavailable" });
        const timer = stateStore.getLocalTimerStatus(localAuth.profileId, decodeURIComponent(timerMatch[1]));
        return json(res, timer ? 200 : 404, timer ? { timer } : { error: "timer_not_found" });
      }

      const timerCancelMatch = url.pathname.match(/^\/timers\/([^/]+)\/cancel$/);
      if (req.method === "POST" && timerCancelMatch) {
        const localAuth = auth(req, url);
        if (!localAuth) return writeUnauthorized(res);
        if (!stateStore) return json(res, 501, { error: "local_store_unavailable" });
        const timerId = decodeURIComponent(timerCancelMatch[1]);
        const existing = stateStore.getLocalTimerStatus(localAuth.profileId, timerId);
        if (!existing) return json(res, 404, { error: "timer_not_found" });
        const timer = existing.status === "scheduled" ? stateStore.cancelLocalTimer(localAuth.profileId, timerId) : existing;
        return json(res, 200, { timer });
      }

      if (req.method === "GET" && url.pathname === "/memories") {
        const localAuth = auth(req, url);
        if (!localAuth) return writeUnauthorized(res);
        const allMemories = baseGateway.listMemories(localAuth.profileId);
        return json(res, 200, {
          memories: filterMemoriesForQuery(allMemories, url.searchParams),
          summary: memorySummary(allMemories),
        });
      }

      if (req.method === "POST" && url.pathname === "/memories") {
        const localAuth = auth(req, url);
        if (!localAuth) return writeUnauthorized(res);
        const memory = baseGateway.addManualMemory(localAuth.profileId, sanitizeManualMemoryBody(await readJson<unknown>(req)));
        return json(res, 201, { memory, summary: memorySummary(baseGateway.listMemories(localAuth.profileId)) });
      }

      const confirmMatch = url.pathname.match(/^\/memories\/([^/]+)\/(confirm|reject)$/);
      if (req.method === "POST" && confirmMatch) {
        const localAuth = auth(req, url);
        if (!localAuth) return writeUnauthorized(res);
        const memoryId = decodeURIComponent(confirmMatch[1]);
        if (confirmMatch[2] === "reject") {
          return json(res, 200, { rejected: baseGateway.rejectMemory(localAuth.profileId, memoryId) });
        }
        const patch = sanitizeMemoryPatch(await readJson<unknown>(req));
        const memory = baseGateway.confirmMemory(localAuth.profileId, memoryId, patch);
        return json(res, memory ? 200 : 404, memory ? { memory } : { error: "memory_not_found" });
      }

      const memoryMatch = url.pathname.match(/^\/memories\/([^/]+)$/);
      if ((req.method === "PATCH" || req.method === "POST") && memoryMatch) {
        const localAuth = auth(req, url);
        if (!localAuth) return writeUnauthorized(res);
        const patch = sanitizeMemoryPatch(await readJson<unknown>(req));
        const memory = baseGateway.updateMemory(localAuth.profileId, decodeURIComponent(memoryMatch[1]), patch);
        return json(res, memory ? 200 : 404, memory ? { memory } : { error: "memory_not_found" });
      }
      if (req.method === "DELETE" && memoryMatch) {
        const localAuth = auth(req, url);
        if (!localAuth) return writeUnauthorized(res);
        const deleted = baseGateway.deleteMemory(localAuth.profileId, decodeURIComponent(memoryMatch[1]));
        return json(res, deleted ? 200 : 404, { deleted });
      }

      if (req.method === "GET" && url.pathname === "/settings") {
        const localAuth = auth(req, url);
        if (!localAuth) return writeUnauthorized(res);
        return json(res, 200, baseGateway.getUserSettings(localAuth.profileId));
      }

      if ((req.method === "PATCH" || req.method === "POST") && url.pathname === "/settings") {
        const patch = sanitizeSettingsPatch(await readJson<unknown>(req));
        const localAuth = auth(req, url);
        if (!localAuth) return writeUnauthorized(res);
        return json(res, 200, baseGateway.updateUserSettings(localAuth.profileId, patch));
      }

      return json(res, 404, { error: "not_found" });
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      const status = statusForError(code);
      return json(res, status, {
        error: status === 500 ? "internal_error" : code,
      });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.LIUKONG_PORT ?? process.env.PORT ?? 3000);
  const host = process.env.LIUKONG_HOST ?? "127.0.0.1";
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  const allowNonLoopback = process.env.LIUKONG_ALLOW_NON_LOOPBACK === "true";
  if (!loopback && !allowNonLoopback) {
    console.error("Refusing to bind non-loopback host in local-first mode. Set LIUKONG_ALLOW_NON_LOOPBACK=true only inside a trusted container/sandbox.");
    process.exit(1);
  }
  createApiServer().listen(port, host, () => {
    console.log(`Liukong local server listening on http://${host}:${port}`);
  });
}

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  AgentGateway,
  createDefaultAgentGateway,
  defaultLocalDataDir,
  defaultLocalProfileId,
  LocalCharacterStore,
  SqliteStateStore,
  validateCharacterCard,
  type CharacterCard,
  type ChatRequest,
  type MemoryType,
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

const CHAT_MODES = new Set(["girlfriend_chat", "girlfriend_complex", "memory_extraction", "safety_rewrite"]);
const CHAT_BODY_KEYS = new Set(["request_id", "user_id", "profile_id", "session_id", "input", "mode", "client_context"]);
const CHAT_INPUT_KEYS = new Set(["type", "text"]);
const CLIENT_CONTEXT_KEYS = new Set(["timezone", "voice_enabled", "avatar_enabled"]);

export interface CreateApiServerOptions {
  gateway?: AgentGateway;
  gatewayFactory?: (apiKey: string) => AgentGateway;
  stateStore?: SqliteStateStore;
  characterStore?: LocalCharacterStore;
  localToken?: string;
  requireLocalToken?: boolean;
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

function providerApiKey(req: IncomingMessage): string {
  const headerKey = firstHeader(req.headers["x-liukong-api-key"] ?? req.headers["x-flowsky-api-key"]);
  return (headerKey || process.env.DEEPSEEK_API_KEY || "").trim();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function statusForError(code: string): number {
  if (code === "request_body_too_large") return 413;
  if (code === "bad_json" || code === "bad_request" || code === "bad_character_card" || code === "missing_provider_key") return 400;
  return 500;
}

function withLocalToken(indexHtml: string, localToken: string, profileId: string): string {
  const boot = `<script>window.__LIUKONG_LOCAL__=${JSON.stringify({ localToken, profileId })};</script>`;
  return indexHtml.replace("</head>", `${boot}\n  </head>`);
}

export function createApiServer(input: AgentGateway | CreateApiServerOptions = {}) {
  const options: CreateApiServerOptions = input instanceof AgentGateway ? { gateway: input } : input;
  const stateStore = options.stateStore ?? (options.gateway ? undefined : new SqliteStateStore());
  const baseGateway = options.gateway ?? createDefaultAgentGateway({ stateStore, allowMissingApiKey: true });
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

  function gatewayForChat(apiKey: string): AgentGateway {
    if (options.gateway) return options.gateway;
    if (options.gatewayFactory) return options.gatewayFactory(apiKey);
    if (!stateStore) return baseGateway;
    return createDefaultAgentGateway({ apiKey, stateStore });
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
        const apiKey = providerApiKey(req);
        if (!apiKey && !options.gateway) throw new Error("missing_provider_key");
        const response = await gatewayForChat(apiKey).chat({ ...body, user_id: localAuth.profileId, profile_id: localAuth.profileId });
        return json(res, 200, response);
      }

      if (req.method === "POST" && url.pathname === "/chat/stream") {
        const body = sanitizeChatRequest(await readJson<unknown>(req));
        const localAuth = auth(req, url, body);
        if (!localAuth) return writeUnauthorized(res);
        const apiKey = providerApiKey(req);
        if (!apiKey && !options.gateway) throw new Error("missing_provider_key");
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        for await (const event of gatewayForChat(apiKey).stream({ ...body, user_id: localAuth.profileId, profile_id: localAuth.profileId })) sseWrite(res, event);
        return res.end();
      }

      if (req.method === "GET" && url.pathname === "/local/export") {
        const localAuth = auth(req, url);
        if (!localAuth) return writeUnauthorized(res);
        if (!stateStore) return json(res, 501, { error: "local_store_unavailable" });
        return json(res, 200, stateStore.exportLocalData(localAuth.profileId));
      }

      if (req.method === "POST" && url.pathname === "/local/reset") {
        const localAuth = auth(req, url);
        if (!localAuth) return writeUnauthorized(res);
        if (!stateStore) return json(res, 501, { error: "local_store_unavailable" });
        stateStore.clearLocalData(localAuth.profileId);
        return json(res, 200, { ok: true });
      }

      if (req.method === "GET" && url.pathname === "/memories") {
        const localAuth = auth(req, url);
        if (!localAuth) return writeUnauthorized(res);
        return json(res, 200, { memories: baseGateway.listMemories(localAuth.profileId) });
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.LIUKONG_PORT ?? process.env.PORT ?? 3000);
  const host = process.env.LIUKONG_HOST ?? process.env.HOST ?? "127.0.0.1";
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

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AgentGateway, createDefaultAgentGateway, type ChatRequest, type MemoryType, type StreamEvent, type UserSettings } from "../../../packages/agent-gateway/src/index.ts";
import { authenticate, writeUnauthorized } from "./auth.ts";

const WEB_INDEX = new URL("../../web/index.html", import.meta.url);
const MAX_BODY_BYTES = Number(process.env.FLOWSKY_MAX_BODY_BYTES ?? 1_000_000);
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

function requestedUserId(url: URL, body?: Partial<ChatRequest>): string | null {
  return body?.user_id ?? url.searchParams.get("user_id");
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

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function statusForError(code: string): number {
  if (code === "request_body_too_large") return 413;
  if (code === "bad_json" || code === "bad_request") return 400;
  return 500;
}

export function createApiServer(gateway: AgentGateway = createDefaultAgentGateway()) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (req.method === "GET" && url.pathname === "/") {
        return html(res, 200, readFileSync(WEB_INDEX, "utf8"));
      }

      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, { ok: true });
      }

      if (req.method === "POST" && url.pathname === "/chat") {
        const body = await readJson<ChatRequest>(req);
        const auth = authenticate(req, requestedUserId(url, body));
        if (!auth) return writeUnauthorized(res);
        const response = await gateway.chat({ ...body, user_id: auth.userId });
        return json(res, 200, response);
      }

      if (req.method === "POST" && url.pathname === "/chat/stream") {
        const body = await readJson<ChatRequest>(req);
        const auth = authenticate(req, requestedUserId(url, body));
        if (!auth) return writeUnauthorized(res);
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        for await (const event of gateway.stream({ ...body, user_id: auth.userId })) sseWrite(res, event);
        return res.end();
      }

      if (req.method === "GET" && url.pathname === "/memories") {
        const auth = authenticate(req, requestedUserId(url));
        if (!auth) return writeUnauthorized(res);
        return json(res, 200, { memories: gateway.listMemories(auth.userId) });
      }

      const confirmMatch = url.pathname.match(/^\/memories\/([^/]+)\/(confirm|reject)$/);
      if (req.method === "POST" && confirmMatch) {
        const auth = authenticate(req, requestedUserId(url));
        if (!auth) return writeUnauthorized(res);
        const memoryId = decodeURIComponent(confirmMatch[1]);
        if (confirmMatch[2] === "reject") {
          return json(res, 200, { rejected: gateway.rejectMemory(auth.userId, memoryId) });
        }
        const patch = sanitizeMemoryPatch(await readJson<unknown>(req));
        const memory = gateway.confirmMemory(auth.userId, memoryId, patch);
        return json(res, memory ? 200 : 404, memory ? { memory } : { error: "memory_not_found" });
      }

      const memoryMatch = url.pathname.match(/^\/memories\/([^/]+)$/);
      if ((req.method === "PATCH" || req.method === "POST") && memoryMatch) {
        const auth = authenticate(req, requestedUserId(url));
        if (!auth) return writeUnauthorized(res);
        const patch = sanitizeMemoryPatch(await readJson<unknown>(req));
        const memory = gateway.updateMemory(auth.userId, decodeURIComponent(memoryMatch[1]), patch);
        return json(res, memory ? 200 : 404, memory ? { memory } : { error: "memory_not_found" });
      }
      if (req.method === "DELETE" && memoryMatch) {
        const auth = authenticate(req, requestedUserId(url));
        if (!auth) return writeUnauthorized(res);
        const deleted = gateway.deleteMemory(auth.userId, decodeURIComponent(memoryMatch[1]));
        return json(res, deleted ? 200 : 404, { deleted });
      }

      if (req.method === "GET" && url.pathname === "/settings") {
        const auth = authenticate(req, requestedUserId(url));
        if (!auth) return writeUnauthorized(res);
        return json(res, 200, gateway.getUserSettings(auth.userId));
      }

      if ((req.method === "PATCH" || req.method === "POST") && url.pathname === "/settings") {
        const patch = sanitizeSettingsPatch(await readJson<unknown>(req));
        const auth = authenticate(req, requestedUserId(url));
        if (!auth) return writeUnauthorized(res);
        return json(res, 200, gateway.updateUserSettings(auth.userId, patch));
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
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "127.0.0.1";
  const hasAuth = Boolean(process.env.FLOWSKY_JWT_SECRET || process.env.FLOWSKY_API_AUTH_TOKEN);
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!loopback && !hasAuth) {
    console.error("Refusing to bind non-loopback host without FLOWSKY_JWT_SECRET or FLOWSKY_API_AUTH_TOKEN");
    process.exit(1);
  }
  createApiServer().listen(port, host, () => {
    console.log(`FlowSky API listening on http://${host}:${port}`);
  });
}

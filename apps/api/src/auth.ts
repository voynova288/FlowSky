import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { defaultLocalDataDir, defaultLocalProfileId, sanitizeLocalProfileId } from "../../../packages/agent-gateway/src/local/paths.ts";

export interface AuthContext {
  profileId: string;
  userId: string;
  mode: "local";
}

export interface LocalAuthOptions {
  localToken: string;
  requireLocalToken: boolean;
  requestedProfileId?: string | null;
}

export function authenticateLocal(req: IncomingMessage, options: LocalAuthOptions): AuthContext | null {
  if (options.requireLocalToken) {
    const token = firstHeader(req.headers["x-liukong-local-token"] ?? req.headers["x-flowsky-local-token"]);
    if (!token || !safeEqual(token, options.localToken)) return null;
  }
  const headerProfile = firstHeader(req.headers["x-liukong-profile-id"] ?? req.headers["x-flowsky-user-id"]);
  const profileId = sanitizeLocalProfileId(headerProfile ?? options.requestedProfileId ?? defaultLocalProfileId());
  return { profileId, userId: profileId, mode: "local" };
}

export function writeUnauthorized(res: ServerResponse): void {
  const body = JSON.stringify({ error: "local_token_required" });
  res.writeHead(401, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function loadOrCreateLocalToken(dataDir = defaultLocalDataDir()): string {
  const tokenPath = resolve(dataDir, "local_token");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (existsSync(tokenPath)) return readFileSync(tokenPath, "utf8").trim();
  const token = randomBytes(32).toString("base64url");
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  return token;
}

export function localTokenRequired(): boolean {
  return process.env.LIUKONG_REQUIRE_LOCAL_TOKEN !== "false" && process.env.FLOWSKY_REQUIRE_LOCAL_TOKEN !== "false";
}

function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

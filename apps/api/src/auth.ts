import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface AuthContext {
  userId: string;
  mode: "dev" | "token" | "jwt";
}

export function authenticate(req: IncomingMessage, fallbackUserId?: string | null): AuthContext | null {
  const jwtSecret = process.env.FLOWSKY_JWT_SECRET;
  const apiToken = process.env.FLOWSKY_API_AUTH_TOKEN;
  const auth = req.headers.authorization ?? "";

  if (jwtSecret) {
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const claims = token ? verifyHs256Jwt(token, jwtSecret) : null;
    if (!claims?.sub || typeof claims.sub !== "string") return null;
    return { userId: claims.sub, mode: "jwt" };
  }

  if (apiToken) {
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!safeEqual(token, apiToken)) return null;
    const headerUser = firstHeader(req.headers["x-flowsky-user-id"]);
    return { userId: headerUser || fallbackUserId || "default-user", mode: "token" };
  }

  return { userId: fallbackUserId || "demo-user", mode: "dev" };
}

export function writeUnauthorized(res: ServerResponse): void {
  const body = JSON.stringify({ error: "unauthorized" });
  res.writeHead(401, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "www-authenticate": "Bearer",
  });
  res.end(body);
}

function verifyHs256Jwt(token: string, secret: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [encodedHeader, encodedPayload, signature] = parts;
    const header = JSON.parse(base64UrlDecode(encodedHeader).toString("utf8"));
    if (header.alg !== "HS256") return null;
    const expected = base64UrlEncode(createHmac("sha256", secret).update(`${encodedHeader}.${encodedPayload}`).digest());
    if (!safeEqual(signature, expected)) return null;
    const claims = JSON.parse(base64UrlDecode(encodedPayload).toString("utf8"));
    if (typeof claims.exp === "number" && Date.now() / 1000 >= claims.exp) return null;
    return claims;
  } catch {
    return null;
  }
}

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function base64UrlEncode(value: Buffer): string {
  return value.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

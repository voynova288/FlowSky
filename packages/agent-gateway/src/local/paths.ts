import { homedir } from "node:os";
import { resolve } from "node:path";

export function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

export function defaultLocalDataDir(): string {
  return expandHomePath(process.env.LIUKONG_DATA_DIR ?? process.env.FLOWSKY_DATA_DIR ?? "~/.liukong");
}

export function defaultLocalDbPath(): string {
  return expandHomePath(
    process.env.LIUKONG_STATE_DB ?? process.env.FLOWSKY_STATE_DB ?? resolve(defaultLocalDataDir(), "liukong.db"),
  );
}

export function defaultLocalProfileId(): string {
  return sanitizeLocalProfileId(process.env.LIUKONG_PROFILE_ID ?? "default");
}

export function sanitizeLocalProfileId(value: string | null | undefined): string {
  const raw = (value ?? "default").trim();
  if (!raw) return "default";
  return raw.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "default";
}

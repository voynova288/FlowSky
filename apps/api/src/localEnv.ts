import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadLocalEnv(cwd = process.cwd()): void {
  for (const file of [".env.local", ".env"]) {
    const path = resolve(cwd, file);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, "");
      const value = unquote(trimmed.slice(eq + 1).trim());
      if (!process.env[key]) process.env[key] = value;
    }
  }

  if (!process.env.DEEPSEEK_API_KEY) {
    const localApiText = resolve(cwd, "API.txt");
    if (existsSync(localApiText)) {
      const apiKey = parseLocalApiText(readFileSync(localApiText, "utf8"));
      if (apiKey) process.env.DEEPSEEK_API_KEY = apiKey;
    }
  }
}

function parseLocalApiText(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const withoutExport = trimmed.replace(/^export\s+/, "");
    const eq = withoutExport.indexOf("=");
    if (eq > 0) {
      const key = withoutExport.slice(0, eq).trim();
      const value = unquote(withoutExport.slice(eq + 1).trim());
      if ((key === "DEEPSEEK_API_KEY" || key === "LIUKONG_DEEPSEEK_API_KEY") && value) return value;
      continue;
    }
    return unquote(withoutExport);
  }
  return "";
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

import { randomUUID } from "node:crypto";

export function randomId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function approxUsageFromMessages(promptText: string, completionText = "") {
  return {
    prompt_tokens: Math.ceil(promptText.length / 4),
    completion_tokens: Math.ceil(completionText.length / 4),
  };
}

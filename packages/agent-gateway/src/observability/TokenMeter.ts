import { createHash } from "node:crypto";
import type { LLMMessage } from "../types.ts";

export function promptHash(messages: LLMMessage[]): string {
  const digest = createHash("sha256");
  for (const message of messages) {
    digest.update(message.role);
    digest.update("\0");
    digest.update(message.content);
    digest.update("\0");
  }
  return digest.digest("hex").slice(0, 16);
}

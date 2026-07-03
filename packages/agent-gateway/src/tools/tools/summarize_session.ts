import type { LLMMessage } from "../../types.ts";

export async function summarize_session(args: { messages: LLMMessage[] }) {
  const text = args.messages
    .slice(-12)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");
  return {
    summary: text.length > 300 ? `${text.slice(0, 300)}...` : text,
    message_count: args.messages.length,
  };
}

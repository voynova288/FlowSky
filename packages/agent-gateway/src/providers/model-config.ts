import type { ChatMode, LLMCompleteRequest } from "../types.ts";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

export function modelConfigForMode(mode: ChatMode = "girlfriend_chat"): Pick<
  LLMCompleteRequest,
  "model" | "temperature" | "thinking" | "reasoning_effort" | "response_format"
> {
  const chatModel = process.env.LIUKONG_CHAT_MODEL ?? process.env.FLOWSKY_CHAT_MODEL ?? "deepseek-v4-flash";
  const complexModel = process.env.LIUKONG_COMPLEX_MODEL ?? process.env.FLOWSKY_COMPLEX_MODEL ?? "deepseek-v4-pro";
  switch (mode) {
    case "girlfriend_complex":
      return {
        model: complexModel,
        temperature: 0.7,
        thinking: { type: "enabled" },
        reasoning_effort: "high",
      };
    case "memory_extraction":
      return {
        model: chatModel,
        temperature: 0.1,
        thinking: { type: "disabled" },
        response_format: { type: "json_object" },
      };
    case "safety_rewrite":
      return {
        model: chatModel,
        temperature: 0.2,
        thinking: { type: "disabled" },
      };
    case "girlfriend_chat":
    default:
      return {
        model: chatModel,
        temperature: 0.8,
        thinking: { type: "disabled" },
      };
  }
}

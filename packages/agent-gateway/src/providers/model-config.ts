import type { ChatMode, LLMCompleteRequest } from "../types.ts";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

export type LLMProviderName = "deepseek" | "openai";

export function normalizeProviderName(raw?: string): LLMProviderName {
  const normalized = (raw ?? process.env.LIUKONG_PROVIDER ?? process.env.FLOWSKY_PROVIDER ?? "deepseek").trim().toLowerCase();
  if (normalized === "deepseek" || normalized === "openai") return normalized;
  throw new Error("bad_provider");
}

export function modelConfigForMode(mode: ChatMode = "girlfriend_chat", providerName: LLMProviderName = "deepseek"): Pick<
  LLMCompleteRequest,
  "model" | "temperature" | "thinking" | "reasoning_effort" | "response_format"
> {
  return providerName === "openai" ? openAIModelConfigForMode(mode) : deepSeekModelConfigForMode(mode);
}

function deepSeekModelConfigForMode(mode: ChatMode): Pick<
  LLMCompleteRequest,
  "model" | "temperature" | "thinking" | "reasoning_effort" | "response_format"
> {
  const chatModel = process.env.LIUKONG_DEEPSEEK_CHAT_MODEL ?? process.env.DEEPSEEK_CHAT_MODEL ?? process.env.LIUKONG_CHAT_MODEL ?? process.env.FLOWSKY_CHAT_MODEL ?? "deepseek-v4-flash";
  const complexModel = process.env.LIUKONG_DEEPSEEK_COMPLEX_MODEL ?? process.env.DEEPSEEK_COMPLEX_MODEL ?? process.env.LIUKONG_COMPLEX_MODEL ?? process.env.FLOWSKY_COMPLEX_MODEL ?? "deepseek-v4-pro";
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

function openAIModelConfigForMode(mode: ChatMode): Pick<
  LLMCompleteRequest,
  "model" | "temperature" | "thinking" | "reasoning_effort" | "response_format"
> {
  const chatModel = process.env.LIUKONG_OPENAI_CHAT_MODEL ?? process.env.OPENAI_CHAT_MODEL ?? "gpt-4o-mini";
  const complexModel = process.env.LIUKONG_OPENAI_COMPLEX_MODEL ?? process.env.OPENAI_COMPLEX_MODEL ?? "gpt-4o";
  switch (mode) {
    case "girlfriend_complex":
      return {
        model: complexModel,
        temperature: 0.7,
      };
    case "memory_extraction":
      return {
        model: chatModel,
        temperature: 0.1,
        response_format: { type: "json_object" },
      };
    case "safety_rewrite":
      return {
        model: chatModel,
        temperature: 0.2,
      };
    case "girlfriend_chat":
    default:
      return {
        model: chatModel,
        temperature: 0.8,
      };
  }
}

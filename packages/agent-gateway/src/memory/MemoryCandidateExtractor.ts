import type { LLMProvider } from "../providers/LLMProvider.ts";
import { modelConfigForMode } from "../providers/model-config.ts";
import type { MemoryCandidate } from "../types.ts";

export class MemoryCandidateExtractor {
  private readonly provider?: LLMProvider;

  constructor(provider?: LLMProvider) {
    this.provider = provider;
  }

  async extract(userMessage: string, sourceMessageId: string): Promise<MemoryCandidate[]> {
    if (!this.provider) return heuristicExtract(userMessage, sourceMessageId);
    const config = modelConfigForMode("memory_extraction");
    const response = await this.provider.complete({
      ...config,
      messages: [
        {
          role: "system",
          content:
            'Extract durable memory candidates as json. Return {"memories": MemoryCandidate[]} only. Do not store temporary emotions or sensitive data without confirmation.',
        },
        { role: "user", content: userMessage },
      ],
    });
    const parsed = JSON.parse(response.text);
    return Array.isArray(parsed.memories) ? parsed.memories : [];
  }
}

function heuristicExtract(userMessage: string, sourceMessageId: string): MemoryCandidate[] {
  const text = userMessage.trim();
  const candidates: MemoryCandidate[] = [];
  if (/记住|以后|我喜欢|我希望|偏好|叫我/.test(text)) {
    candidates.push({
      should_store: true,
      memory_type: /叫我|称呼/.test(text) ? "profile_memory" : "preference_memory",
      content: text,
      confidence: 0.82,
      sensitivity: "low",
      needs_user_confirmation: false,
      source_message_id: sourceMessageId,
    });
  }
  if (/身份证|地址|手机号|健康|心理|家人|学校|公司|位置/.test(text)) {
    candidates.push({
      should_store: false,
      memory_type: "sensitive_memory",
      content: text,
      confidence: 0.75,
      sensitivity: "high",
      needs_user_confirmation: true,
      source_message_id: sourceMessageId,
    });
  }
  return candidates;
}

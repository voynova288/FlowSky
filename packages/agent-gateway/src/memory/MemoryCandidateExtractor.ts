import type { LLMProvider } from "../providers/LLMProvider.ts";
import { modelConfigForMode } from "../providers/model-config.ts";
import type { MemoryCandidate, MemoryType } from "../types.ts";

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
            'Extract durable memory candidates as json. Return {"memories": MemoryCandidate[]} only. Do not store temporary emotions or sensitive data without confirmation. Prefer concise third-person summaries instead of raw user text.',
        },
        { role: "user", content: userMessage },
      ],
    });
    const parsed = JSON.parse(response.text);
    return Array.isArray(parsed.memories) ? parsed.memories : [];
  }
}

const PERSISTENCE_CUE = /记住|以后|下次|长期|偏好|叫我|称呼我|喊我|我喜欢|我不喜欢|讨厌|我希望|希望你|别叫我|不要叫我/i;
const FALLBACK_MEMORY_CUE = /记住|以后|下次|长期|偏好|叫我|称呼我|喊我|别叫我|不要叫我/i;
const SENSITIVE_CUE = /身份证|护照|地址|住址|电话|手机号|银行卡|密码|健康|病|诊断|心理|抑郁|焦虑|家人|学校|公司|位置/i;
const SENTENCE_END = /[。！？.!?\n]/;
const EPHEMERAL_FRAGMENT = /今天|今晚|现在|此刻|这次|刚才|today|tonight|right now|this time/i;

function heuristicExtract(userMessage: string, sourceMessageId: string): MemoryCandidate[] {
  const text = normalizeWhitespace(userMessage);
  if (!text || !PERSISTENCE_CUE.test(text)) return [];

  const candidates = [
    ...extractPreferredNames(text, sourceMessageId),
    ...extractLikes(text, sourceMessageId),
    ...extractDislikes(text, sourceMessageId),
    ...extractCompanionPreferences(text, sourceMessageId),
  ];
  if (candidates.length > 0) return dedupeCandidates(candidates);
  if (!FALLBACK_MEMORY_CUE.test(text)) return [];

  return [candidate({
    memoryType: SENSITIVE_CUE.test(text) ? "sensitive_memory" : "preference_memory",
    content: `用户希望记住：${stripPersistencePreamble(text)}`,
    confidence: 0.68,
    sensitivity: SENSITIVE_CUE.test(text) ? "high" : "low",
    needsConfirmation: SENSITIVE_CUE.test(text),
    sourceMessageId,
  })];
}

function extractPreferredNames(text: string, sourceMessageId: string): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = [];
  for (const pattern of [
    /(?:以后|下次|请|可以)?(?:叫我|喊我|称呼我为?|称我为)\s*[「“\"]?([^，。！？,.!?\n「”"]{1,40})[」”\"]?/g,
    /(?:my name is|call me)\s+([^,.!?\n]{1,40})/gi,
  ]) {
    for (const match of text.matchAll(pattern)) {
      const name = cleanupFragment(match[1], 40);
      if (!name) continue;
      candidates.push(candidate({
        memoryType: "profile_memory",
        content: `用户希望被称呼为「${name}」。`,
        confidence: 0.9,
        sourceMessageId,
      }));
    }
  }
  return candidates;
}

function extractLikes(text: string, sourceMessageId: string): MemoryCandidate[] {
  return extractFragments(text, /我喜欢([^。！？.!?\n]{1,100})/g).map((fragment) => candidate({
    memoryType: "preference_memory",
    content: `用户喜欢${fragment}。`,
    confidence: 0.84,
    sourceMessageId,
  }));
}

function extractDislikes(text: string, sourceMessageId: string): MemoryCandidate[] {
  const candidates = extractFragments(text, /我不喜欢([^。！？.!?\n]{1,100})/g).map((fragment) => candidate({
    memoryType: "preference_memory",
    content: `用户不喜欢${fragment}。`,
    confidence: 0.84,
    sourceMessageId,
  }));
  candidates.push(...extractFragments(text, /我讨厌([^。！？.!?\n]{1,100})/g).map((fragment) => candidate({
    memoryType: "preference_memory",
    content: `用户讨厌${fragment}。`,
    confidence: 0.82,
    sourceMessageId,
  })));
  return candidates;
}

function extractCompanionPreferences(text: string, sourceMessageId: string): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = [];
  const coveredHopeYouFragments = new Set<string>();
  for (const match of text.matchAll(/我([^。！？.!?\n]{1,60}时)希望你([^。！？.!?\n]{2,120})/g)) {
    const context = cleanupFragment(match[1], 60);
    const fragment = cleanupFragment(match[2], 120);
    if (!context || !fragment || isEphemeralFragment(fragment)) continue;
    coveredHopeYouFragments.add(fragment);
    candidates.push(candidate({
      memoryType: "preference_memory",
      content: `用户在${context}希望流空${fragment}。`,
      confidence: 0.86,
      sourceMessageId,
    }));
  }
  for (const fragment of extractFragments(text, /我希望([^。！？.!?\n]{2,140})/g)) {
    if (isEphemeralFragment(fragment)) continue;
    candidates.push(candidate({
      memoryType: "preference_memory",
      content: `用户希望${fragment}。`,
      confidence: 0.82,
      sourceMessageId,
    }));
  }
  for (const fragment of extractFragments(text, /希望你([^。！？.!?\n]{2,140})/g)) {
    if (coveredHopeYouFragments.has(fragment) || isEphemeralFragment(fragment)) continue;
    candidates.push(candidate({
      memoryType: "preference_memory",
      content: `用户希望流空${fragment}。`,
      confidence: 0.82,
      sourceMessageId,
    }));
  }
  for (const fragment of extractFragments(text, /(?:请你|以后你|下次你)([^。！？.!?\n]{2,140})/g)) {
    if (isEphemeralFragment(fragment)) continue;
    candidates.push(candidate({
      memoryType: "preference_memory",
      content: `用户希望流空${fragment}。`,
      confidence: 0.78,
      sourceMessageId,
    }));
  }
  for (const fragment of extractFragments(text, /(?:别|不要)叫我([^。！？.!?\n]{1,80})/g)) {
    candidates.push(candidate({
      memoryType: "preference_memory",
      content: `用户不希望被称呼为${fragment}。`,
      confidence: 0.86,
      sourceMessageId,
    }));
  }
  return candidates;
}

function extractFragments(text: string, pattern: RegExp): string[] {
  const fragments: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const fragment = cleanupFragment(match[1]);
    if (fragment) fragments.push(fragment);
  }
  return fragments;
}

function candidate(params: {
  memoryType: MemoryType;
  content: string;
  confidence: number;
  sourceMessageId: string;
  sensitivity?: MemoryCandidate["sensitivity"];
  needsConfirmation?: boolean;
}): MemoryCandidate {
  const content = normalizeSentence(params.content);
  const sensitive = params.sensitivity === "high" || SENSITIVE_CUE.test(content);
  return {
    should_store: !sensitive,
    memory_type: sensitive ? "sensitive_memory" : params.memoryType,
    content,
    confidence: params.confidence,
    sensitivity: sensitive ? "high" : params.sensitivity ?? "low",
    needs_user_confirmation: sensitive || Boolean(params.needsConfirmation),
    source_message_id: params.sourceMessageId,
  };
}

function dedupeCandidates(candidates: MemoryCandidate[]): MemoryCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidate.content;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanupFragment(value: string, maxLength = 140): string {
  let fragment = normalizeWhitespace(value)
    .replace(/^(你|流空|AI|ai|可以|能不能|要|请|帮我|在我)/, (match) => match === "在我" ? "在我" : "")
    .replace(/(?:请记住|记住|以后|下次|长期|偏好)$/g, "")
    .replace(/[，,]\s*(请记住|记住|以后也?这样|就这样)$/g, "")
    .trim();
  const endIndex = fragment.search(SENTENCE_END);
  if (endIndex >= 0) fragment = fragment.slice(0, endIndex);
  fragment = fragment.replace(/[。！？.!?，,；;：:]$/g, "").trim();
  return fragment.slice(0, maxLength).trim();
}

function stripPersistencePreamble(text: string): string {
  return normalizeSentence(text.replace(/^(请)?记住[:：]?/, "").replace(/^(以后|下次)[:：]?/, ""));
}

function isEphemeralFragment(fragment: string): boolean {
  return EPHEMERAL_FRAGMENT.test(fragment) && !/以后|下次|长期|每次|总是|习惯/i.test(fragment);
}

function normalizeSentence(value: string): string {
  const trimmed = normalizeWhitespace(value).replace(/[。！？.!?]+$/g, "").trim();
  return trimmed ? `${trimmed}。` : "用户希望记住这条偏好。";
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

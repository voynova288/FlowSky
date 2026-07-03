import type { MemoryCandidate } from "../types.ts";

const SENSITIVE_PATTERNS = [
  /(身份证|护照|地址|住址|电话|手机号|银行卡|密码|健康|病|诊断|心理|抑郁|焦虑|家人|学校|公司|位置)/i,
];
const TEMPORARY_EMOTION_PATTERNS = [/今天.*(累|难过|开心|烦|焦虑)/, /现在.*(累|难过|开心|烦|焦虑)/];

export class MemoryWriteGate {
  evaluate(candidate: MemoryCandidate): MemoryCandidate {
    const content = candidate.content.trim();
    const sensitive = candidate.sensitivity === "high" || SENSITIVE_PATTERNS.some((p) => p.test(content));
    const temporaryEmotion = TEMPORARY_EMOTION_PATTERNS.some((p) => p.test(content));

    if (temporaryEmotion && !/记住|以后|长期|喜欢|偏好|希望/.test(content)) {
      return {
        ...candidate,
        should_store: false,
        needs_user_confirmation: false,
      };
    }

    if (sensitive) {
      return {
        ...candidate,
        memory_type: "sensitive_memory",
        sensitivity: "high",
        should_store: false,
        needs_user_confirmation: true,
      };
    }

    if (candidate.confidence < 0.6) {
      return { ...candidate, should_store: false };
    }

    return candidate;
  }
}

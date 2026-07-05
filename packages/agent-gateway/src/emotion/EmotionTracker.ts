import type { EmotionalState, EmotionalSupportNeed, UserMood } from "../types.ts";
import { nowIso } from "../util.ts";

const MOOD_RULES: Array<{ mood: UserMood; valence: EmotionalState["valence"]; support_need: EmotionalSupportNeed; patterns: RegExp[] }> = [
  { mood: "tired", valence: -1, support_need: "comfort", patterns: [/累|疲惫|困|没力气|burn(?:ed)? out|tired|exhausted/i] },
  { mood: "anxious", valence: -2, support_need: "comfort", patterns: [/焦虑|慌|紧张|害怕|担心|压力|anxious|panic|worried|stress/i] },
  { mood: "sad", valence: -2, support_need: "comfort", patterns: [/难过|伤心|委屈|想哭|崩溃|sad|upset|cry/i] },
  { mood: "lonely", valence: -1, support_need: "listening", patterns: [/孤独|没人陪|一个人|寂寞|lonely|alone/i] },
  { mood: "angry", valence: -1, support_need: "space", patterns: [/生气|烦死|愤怒|火大|angry|furious|annoyed/i] },
  { mood: "happy", valence: 2, support_need: "celebration", patterns: [/开心|高兴|顺利|太好了|兴奋|happy|great|excited/i] },
];

const HIGH_INTENSITY = /崩溃|受不了|非常|特别|很|太|panic|extremely|really|so /i;
const LOW_INTENSITY = /有点|稍微|一点|a bit|slightly/i;
const RECOVERY = /没事了|好多了|好些了|缓过来了|冷静下来了|平静下来了|不难过了|不焦虑了|不生气了|已经好了|better now|okay now|ok now|calm now/i;

export function inferEmotionalState(text: string, previous?: EmotionalState | null, sourceMessageId?: string): EmotionalState {
  const normalized = text.trim();
  if (RECOVERY.test(normalized)) return neutralState(sourceMessageId);
  const matched = MOOD_RULES.find((rule) => rule.patterns.some((pattern) => pattern.test(normalized)));
  if (!matched) {
    if (previous && shouldKeepPrevious(previous)) {
      return { ...previous, updated_at: nowIso(), source_message_id: sourceMessageId ?? previous.source_message_id };
    }
    return neutralState(sourceMessageId);
  }
  return {
    mood: matched.mood,
    intensity: inferIntensity(normalized, matched.mood),
    valence: matched.valence,
    support_need: matched.support_need,
    updated_at: nowIso(),
    source_message_id: sourceMessageId,
  };
}

export function shouldPersistEmotionalState(state: EmotionalState, previous?: EmotionalState | null): boolean {
  if (state.mood !== "neutral" || state.intensity > 1) return true;
  return Boolean(previous && previous.mood !== "neutral");
}

function inferIntensity(text: string, mood: UserMood): number {
  let intensity = mood === "happy" ? 3 : 2;
  if (HIGH_INTENSITY.test(text)) intensity += 1;
  if (LOW_INTENSITY.test(text)) intensity -= 1;
  return Math.max(1, Math.min(5, intensity));
}

function shouldKeepPrevious(previous: EmotionalState): boolean {
  if (previous.mood === "neutral") return false;
  const updated = Date.parse(previous.updated_at);
  if (!Number.isFinite(updated)) return false;
  return Date.now() - updated < 6 * 60 * 60 * 1000;
}

function neutralState(sourceMessageId?: string): EmotionalState {
  return {
    mood: "neutral",
    intensity: 1,
    valence: 0,
    support_need: "listening",
    updated_at: nowIso(),
    source_message_id: sourceMessageId,
  };
}

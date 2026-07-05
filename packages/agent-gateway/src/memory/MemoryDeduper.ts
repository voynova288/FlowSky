import type { MemoryCandidate, StoredMemory } from "../types.ts";

export type MemoryMergeDecision =
  | { action: "save" }
  | { action: "skip"; target: StoredMemory; reason: "duplicate" }
  | { action: "update"; target: StoredMemory; content: string; reason: "newer_preference" };

export function mergeMemoryCandidate(existing: StoredMemory[], candidate: MemoryCandidate): MemoryMergeDecision {
  const exact = existing.find((memory) => sameDurableContent(memory, candidate));
  if (exact) return { action: "skip", target: exact, reason: "duplicate" };

  const candidateSlot = memorySlot(candidate);
  if (!candidateSlot || !isAutoStored(candidate)) return { action: "save" };

  const target = existing.find((memory) => isAutoStored(memory) && memorySlot(memory) === candidateSlot);
  if (!target) return { action: "save" };
  return { action: "update", target, content: candidate.content, reason: "newer_preference" };
}

function sameDurableContent(memory: StoredMemory, candidate: MemoryCandidate): boolean {
  return memory.memory_type === candidate.memory_type && canonical(memory.content) === canonical(candidate.content);
}

function isAutoStored(memory: MemoryCandidate | StoredMemory): boolean {
  return memory.should_store && !memory.needs_user_confirmation && memory.sensitivity !== "high" && (
    "user_confirmed" in memory ? Boolean(memory.user_confirmed) : true
  );
}

function memorySlot(memory: Pick<MemoryCandidate, "memory_type" | "content">): string | null {
  const content = canonical(memory.content);
  const preferredName = content.match(/^用户希望被称呼为「.+」。?$/);
  if (preferredName && memory.memory_type === "profile_memory") return "profile:preferred_name";

  const blockedName = content.match(/^用户不希望被称呼为(.+?)。?$/);
  if (blockedName) return `profile:blocked_name:${canonical(blockedName[1])}`;

  const supportContext = content.match(/^用户在(.+?时)希望流空/);
  if (supportContext) return `support:${canonical(supportContext[1])}`;

  if (isCommunicationPreference(content)) return "preference:communication_style";
  return null;
}

function isCommunicationPreference(content: string): boolean {
  if (!content.startsWith("用户")) return false;
  return /回复|短句|长句|语气|口吻|安慰|陪伴|倾听|听我说|建议|油腻|直接|温柔|严肃|撒娇|主动|不要马上/.test(content);
}

function canonical(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[.!?]+$/g, "。")
    .replace(/。+$/g, "。")
    .trim();
}

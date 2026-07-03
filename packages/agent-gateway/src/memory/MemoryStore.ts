import type { MemoryCandidate, StoredMemory } from "../types.ts";
import { randomId, nowIso } from "../util.ts";

export interface MemoryStoreLike {
  save(userId: string, candidate: MemoryCandidate, userConfirmed?: boolean): StoredMemory;
  list(userId: string): StoredMemory[];
  retrieve(userId: string, query: string, limit?: number): StoredMemory[];
  delete(userId: string, memoryId: string): boolean;
  confirm?(userId: string, memoryId: string, patch?: Partial<Pick<StoredMemory, "content" | "memory_type">>): StoredMemory | null;
  reject?(userId: string, memoryId: string): boolean;
  updateMemory?(userId: string, memoryId: string, patch: Partial<Pick<StoredMemory, "content" | "memory_type">>): StoredMemory | null;
}

export class InMemoryMemoryStore implements MemoryStoreLike {
  private readonly memories = new Map<string, StoredMemory>();

  save(userId: string, candidate: MemoryCandidate, userConfirmed = false): StoredMemory {
    const memory: StoredMemory = {
      ...candidate,
      id: randomId("mem"),
      user_id: userId,
      user_confirmed: userConfirmed,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    this.memories.set(memory.id, memory);
    return memory;
  }

  list(userId: string): StoredMemory[] {
    return [...this.memories.values()].filter((m) => m.user_id === userId && !m.deleted_at);
  }

  retrieve(userId: string, query: string, limit = 8): StoredMemory[] {
    const words = new Set(query.toLowerCase().split(/\s+/).filter(Boolean));
    return this.list(userId)
      .filter((memory) => memory.should_store && memory.user_confirmed && !memory.needs_user_confirmation)
      .map((memory) => ({
        memory,
        score: [...words].filter((w) => memory.content.toLowerCase().includes(w)).length,
      }))
      .sort((a, b) => b.score - a.score || b.memory.confidence - a.memory.confidence)
      .slice(0, limit)
      .map((x) => x.memory);
  }

  delete(userId: string, memoryId: string): boolean {
    const memory = this.memories.get(memoryId);
    if (!memory || memory.user_id !== userId) return false;
    memory.deleted_at = nowIso();
    memory.updated_at = nowIso();
    return true;
  }

  confirm(userId: string, memoryId: string, patch: Partial<Pick<StoredMemory, "content" | "memory_type">> = {}): StoredMemory | null {
    const memory = this.memories.get(memoryId);
    if (!memory || memory.user_id !== userId || memory.deleted_at) return null;
    if (patch.content !== undefined) memory.content = patch.content;
    if (patch.memory_type !== undefined) memory.memory_type = patch.memory_type;
    memory.should_store = true;
    memory.user_confirmed = true;
    memory.needs_user_confirmation = false;
    memory.updated_at = nowIso();
    return memory;
  }

  reject(userId: string, memoryId: string): boolean {
    return this.delete(userId, memoryId);
  }

  updateMemory(userId: string, memoryId: string, patch: Partial<Pick<StoredMemory, "content" | "memory_type">>): StoredMemory | null {
    const memory = this.memories.get(memoryId);
    if (!memory || memory.user_id !== userId || memory.deleted_at) return null;
    if (patch.content !== undefined) memory.content = patch.content;
    if (patch.memory_type !== undefined) memory.memory_type = patch.memory_type;
    memory.updated_at = nowIso();
    return memory;
  }
}

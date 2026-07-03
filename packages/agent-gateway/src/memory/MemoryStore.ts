import type { MemoryCandidate, StoredMemory } from "../types.ts";
import { randomId, nowIso } from "../util.ts";

export interface MemoryStoreLike {
  save(userId: string, candidate: MemoryCandidate, userConfirmed?: boolean): StoredMemory;
  list(userId: string): StoredMemory[];
  retrieve(userId: string, query: string, limit?: number): StoredMemory[];
  delete(userId: string, memoryId: string): boolean;
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
}

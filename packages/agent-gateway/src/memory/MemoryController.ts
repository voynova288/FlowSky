import { MemoryCandidateExtractor } from "./MemoryCandidateExtractor.ts";
import { InMemoryMemoryStore, type MemoryStoreLike } from "./MemoryStore.ts";
import { MemoryWriteGate } from "./MemoryWriteGate.ts";
import type { LLMProvider } from "../providers/LLMProvider.ts";
import type { MemoryCandidate, StoredMemory, UserSettings } from "../types.ts";

export class MemoryController {
  readonly store: MemoryStoreLike;
  private readonly extractor: MemoryCandidateExtractor;
  private readonly writeGate = new MemoryWriteGate();

  constructor(options: { provider?: LLMProvider; store?: MemoryStoreLike } = {}) {
    this.store = options.store ?? new InMemoryMemoryStore();
    this.extractor = new MemoryCandidateExtractor(options.provider);
  }

  async processUserMessage(params: {
    userId: string;
    message: string;
    sourceMessageId: string;
    settings: UserSettings;
  }): Promise<MemoryCandidate[]> {
    if (!params.settings.memory_enabled) return [];
    const extracted = await this.extractor.extract(params.message, params.sourceMessageId);
    const gated = extracted.map((candidate) => this.writeGate.evaluate(candidate));
    for (const candidate of gated) {
      if (candidate.should_store && !candidate.needs_user_confirmation) {
        this.store.save(params.userId, candidate, true);
      } else if (candidate.needs_user_confirmation) {
        this.store.save(params.userId, candidate, false);
      }
    }
    return gated;
  }

  retrieve(userId: string, query: string): StoredMemory[] {
    return this.store.retrieve(userId, query);
  }

  list(userId: string): StoredMemory[] {
    return this.store.list(userId);
  }

  delete(userId: string, memoryId: string): boolean {
    return this.store.delete(userId, memoryId);
  }

  confirm(
    userId: string,
    memoryId: string,
    patch: Partial<Pick<StoredMemory, "content" | "memory_type">> = {},
  ): StoredMemory | null {
    return this.store.confirm?.(userId, memoryId, patch) ?? null;
  }

  reject(userId: string, memoryId: string): boolean {
    return this.store.reject?.(userId, memoryId) ?? this.store.delete(userId, memoryId);
  }

  updateMemory(
    userId: string,
    memoryId: string,
    patch: Partial<Pick<StoredMemory, "content" | "memory_type">>,
  ): StoredMemory | null {
    return this.store.updateMemory?.(userId, memoryId, patch) ?? null;
  }
}

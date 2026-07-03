import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CharacterCard, LLMMessage, RelationshipState, StoredMemory, UserSettings } from "../types.ts";
import { validateCharacterCard } from "../character/LocalCharacterStore.ts";

const here = dirname(fileURLToPath(import.meta.url));

export interface PromptAssemblerInput {
  character_id?: string;
  relationship_state: RelationshipState;
  user_settings: UserSettings;
  retrieved_memories: StoredMemory[];
  recent_history: LLMMessage[];
  tool_results?: LLMMessage[];
  current_user_input: string;
}

export interface CharacterStoreLike {
  loadCharacter(id?: string): CharacterCard;
}

export interface PromptAssemblerOptions {
  baseDir?: string;
  characterStore?: CharacterStoreLike;
}

export class PromptAssembler {
  private readonly baseDir: string;
  private readonly characterStore?: CharacterStoreLike;

  constructor(options: string | PromptAssemblerOptions = here) {
    if (typeof options === "string") {
      this.baseDir = options;
    } else {
      this.baseDir = options.baseDir ?? here;
      this.characterStore = options.characterStore;
    }
  }

  assemble(input: PromptAssemblerInput): LLMMessage[] {
    const character = this.loadCharacter(input.character_id ?? "default_girlfriend");
    const systemPolicy = this.loadText("system_policy.md");
    const compliancePolicy = this.loadText("compliance_policy.md");
    const outputFormat = this.loadText("output_format.md");

    const systemMessages: LLMMessage[] = [
      { role: "system", content: systemPolicy },
      { role: "system", content: compliancePolicy },
      { role: "system", content: `角色卡：${JSON.stringify(character, null, 2)}` },
      { role: "system", content: this.renderRomanceConfig(input.user_settings) },
      { role: "system", content: `关系状态：${JSON.stringify(input.relationship_state)}` },
      { role: "system", content: `用户设置：${JSON.stringify(input.user_settings)}` },
      { role: "system", content: this.renderMemories(input.retrieved_memories) },
      { role: "system", content: outputFormat },
    ];

    return [
      ...systemMessages,
      ...input.recent_history,
      ...(input.tool_results ?? []),
      { role: "user", content: input.current_user_input },
    ];
  }

  loadCharacter(id = "default_girlfriend"): CharacterCard {
    if (this.characterStore) return this.characterStore.loadCharacter(id);
    const raw = readFileSync(join(this.baseDir, "character_cards", `${id}.json`), "utf8");
    return validateCharacterCard(JSON.parse(raw));
  }

  private loadText(file: string): string {
    return readFileSync(join(this.baseDir, file), "utf8").trim();
  }

  private renderMemories(memories: StoredMemory[]): string {
    if (memories.length === 0) return "相关记忆：无。";
    const lines = memories.map((m) => `- [${m.memory_type}/${m.sensitivity}] ${m.content}`);
    return `相关记忆：\n${lines.join("\n")}`;
  }

  private renderRomanceConfig(settings: UserSettings): string {
    return `感情真实感配置：${JSON.stringify({
      enabled: Boolean(settings.adult_romance_enabled),
      level: settings.romance_realism_level,
      allow_playful_jealousy: settings.romance_realism_level >= 1,
      allow_mild_disappointment: settings.romance_realism_level >= 1,
      allow_soft_coquetry: settings.romance_realism_level >= 1,
      allow_threats: false,
      allow_silent_treatment: false,
      allow_dependency_reinforcement: false,
      allow_social_isolation: false,
      allow_consumption_pressure: false,
      require_autonomy_reassurance: true,
      max_emotional_pressure: "low",
    })}`;
  }
}

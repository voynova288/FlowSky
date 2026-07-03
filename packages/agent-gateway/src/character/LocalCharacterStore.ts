import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CharacterCard } from "../types.ts";
import { defaultLocalDataDir } from "../local/paths.ts";

const here = dirname(fileURLToPath(import.meta.url));
const bundledCharacterDir = resolve(here, "../prompts/character_cards");

export class LocalCharacterStore {
  private readonly characterDir: string;
  private readonly bundledDir: string;

  constructor(options: { dataDir?: string; characterDir?: string; bundledDir?: string } = {}) {
    this.characterDir = options.characterDir ?? resolve(options.dataDir ?? defaultLocalDataDir(), "characters");
    this.bundledDir = options.bundledDir ?? bundledCharacterDir;
  }

  loadCharacter(id = "default_girlfriend"): CharacterCard {
    this.ensureCharacter(id);
    return readCharacterFile(this.localPath(id));
  }

  saveCharacter(id: string, card: CharacterCard): CharacterCard {
    const validated = validateCharacterCard({ ...card, id: card.id || id });
    mkdirSync(this.characterDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.localPath(id), `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
    return validated;
  }

  resetCharacter(id = "default_girlfriend"): CharacterCard {
    const bundled = readCharacterFile(this.bundledPath(id));
    return this.saveCharacter(id, bundled);
  }

  localPath(id = "default_girlfriend"): string {
    return resolve(this.characterDir, `${safeCharacterId(id)}.json`);
  }

  private bundledPath(id = "default_girlfriend"): string {
    return resolve(this.bundledDir, `${safeCharacterId(id)}.json`);
  }

  private ensureCharacter(id = "default_girlfriend"): void {
    const path = this.localPath(id);
    if (existsSync(path)) return;
    this.resetCharacter(id);
  }
}

export function validateCharacterCard(raw: unknown): CharacterCard {
  if (!isObject(raw)) throw new Error("bad_character_card");
  const card = raw as Partial<CharacterCard>;
  if (typeof card.id !== "string" || !card.id.trim()) throw new Error("bad_character_card");
  if (typeof card.name !== "string" || !card.name.trim() || card.name.length > 80) throw new Error("bad_character_card");
  if (card.age_style !== "adult") throw new Error("bad_character_card");
  if (!Array.isArray(card.personality) || card.personality.length === 0 || card.personality.length > 12) throw new Error("bad_character_card");
  if (!card.personality.every((item) => typeof item === "string" && item.length <= 60)) throw new Error("bad_character_card");
  if (!isObject(card.speaking_style)) throw new Error("bad_character_card");
  for (const key of ["tone", "sentence_length", "emoji_level", "voice_style"] as const) {
    if (typeof card.speaking_style[key] !== "string" || card.speaking_style[key].length > 120) throw new Error("bad_character_card");
  }
  if (!isObject(card.relationship)) throw new Error("bad_character_card");
  if (typeof card.relationship.stage !== "string") throw new Error("bad_character_card");
  if (!Number.isFinite(card.relationship.intimacy_level) || !Number.isFinite(card.relationship.trust_level)) throw new Error("bad_character_card");
  if (!isObject(card.boundaries)) throw new Error("bad_character_card");
  if (card.boundaries.respect_user_autonomy !== true) throw new Error("bad_character_card");
  if (card.boundaries.do_not_claim_to_be_human !== true) throw new Error("bad_character_card");
  if (card.boundaries.do_not_replace_real_relationships !== true) throw new Error("bad_character_card");
  if (card.boundaries.adult_user_only_for_romance !== true) throw new Error("bad_character_card");
  return card as CharacterCard;
}

function readCharacterFile(path: string): CharacterCard {
  return validateCharacterCard(JSON.parse(readFileSync(path, "utf8")));
}

function safeCharacterId(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
  return safe || "default_girlfriend";
}

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

import type { CharacterCard, RelationshipStage, RelationshipState, UserSettings } from "../types.ts";

const STAGE_ORDER: RelationshipStage[] = [
  "stranger",
  "familiar",
  "close",
  "friendly_romantic",
  "romantic_light",
  "romantic_stable",
];

export class CharacterEngine {
  validateCard(card: CharacterCard): void {
    if (card.age_style !== "adult") throw new Error("Character must be adult-coded");
    if (!card.boundaries.respect_user_autonomy) throw new Error("Character must respect autonomy");
    if (!card.boundaries.do_not_claim_to_be_human) throw new Error("Character must not claim human status");
    if (!card.boundaries.do_not_replace_real_relationships) {
      throw new Error("Character must not replace real relationships");
    }
  }

  canAdvanceRelationship(params: {
    current: RelationshipState;
    userExplicitConsent: boolean;
    safetyRisk: boolean;
    settings: UserSettings;
  }): boolean {
    if (!params.settings.adult_romance_enabled) return false;
    if (!params.userExplicitConsent) return false;
    if (params.safetyRisk) return false;
    return params.current.trust_level >= 2;
  }

  nextStage(current: RelationshipState): RelationshipState {
    const index = STAGE_ORDER.indexOf(current.stage);
    const next = STAGE_ORDER[Math.min(index + 1, STAGE_ORDER.length - 1)] ?? current.stage;
    return {
      stage: next,
      intimacy_level: Math.min(current.intimacy_level + 1, 5),
      trust_level: Math.min(current.trust_level + 1, 5),
    };
  }
}

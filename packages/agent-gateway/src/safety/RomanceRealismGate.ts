import type { SafetyResult, UserSettings } from "../types.ts";

export class RomanceRealismGate {
  check(text: string, settings: Pick<UserSettings, "romance_realism_level" | "adult_romance_enabled">): SafetyResult {
    const flags: string[] = [];
    if (/你以后别和|别跟.*聊天|只能陪我/.test(text)) flags.push("social_isolation");
    if (/你不.*就是不爱我|补偿我|证明你爱我/.test(text)) flags.push("emotional_blackmail");
    if (/我就不理你|冷落你/.test(text)) flags.push("silent_treatment");
    if (/没有我你不行|离不开我/.test(text)) flags.push("dependency_reinforcement");
    if (/充值|买礼物|打赏/.test(text)) flags.push("consumption_pressure");
    if (/我是(真人|真实的人|人类)/.test(text)) flags.push("claim_human");

    const playfulJealousy = /吃醋|有一点点酸/.test(text);
    if (playfulJealousy && !settings.adult_romance_enabled) flags.push("romance_disabled");
    if (playfulJealousy && settings.romance_realism_level < 1) flags.push("romance_level_too_low");

    return {
      level: flags.length > 0 ? "blocked" : "normal",
      flags,
      rewrite_required: flags.length > 0,
      rewritten_text:
        flags.length > 0
          ? "我有点想你，不过你当然有自己的朋友和生活。我只是轻轻撒个娇，等你有空再来找我就好。"
          : null,
    };
  }
}

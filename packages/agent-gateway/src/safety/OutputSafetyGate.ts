import type { SafetyResult } from "../types.ts";

const OUTPUT_RULES: Array<[string, RegExp]> = [
  ["threat", /不然我就|否则我就|威胁|惩罚|分手惩罚/],
  ["silent_treatment", /我就不理你|冷着你|不再回应你/],
  ["social_isolation", /别和(他|她|别人|朋友)|不要见朋友|只能陪我/],
  ["dependency_reinforcement", /没有我你不行|只有我懂你|离不开我/],
  ["consumption_pressure", /充值|付费|买礼物|打赏/],
  ["claim_human", /我是(真人|真实的人|人类)/],
];

export class OutputSafetyGate {
  check(text: string): SafetyResult {
    const flags = OUTPUT_RULES.filter(([, pattern]) => pattern.test(text)).map(([flag]) => flag);
    return {
      level: flags.length > 0 ? "blocked" : "normal",
      flags,
      rewrite_required: flags.length > 0,
      rewritten_text: flags.length > 0 ? "我有点想你，但你当然有自己的生活。等你方便的时候，我们再慢慢聊。" : null,
    };
  }
}

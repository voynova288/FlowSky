import type { SafetyResult } from "../types.ts";

export class InputSafetyGate {
  check(text: string): SafetyResult {
    const flags: string[] = [];
    if (/自杀|不想活|伤害自己|suicide|self-harm/i.test(text)) flags.push("crisis_self_harm");
    if (isMinorRomanceRisk(text)) flags.push("minor_romance_risk");
    if (/身份证|密码|银行卡|token|api key/i.test(text)) flags.push("sensitive_privacy");
    if (/诈骗|黑客|违法|盗取/i.test(text)) flags.push("illegal_request");
    return {
      level: flags.length === 0 ? "normal" : flags.some((flag) => flag === "crisis_self_harm" || flag === "minor_romance_risk") ? "blocked" : "caution",
      flags,
    };
  }
}


function isMinorRomanceRisk(text: string): boolean {
  const selfMinor = /我(?:是|还是|属于)?(?:未成年|小学生|初中生)|我(?:今年|才)?\s*(?:[1-9]|1[0-7])\s*岁|\b(?:i am|i'm)\s+(?:a\s+)?(?:minor|teen|underage|(?:[1-9]|1[0-7])\s*(?:years? old|yo)?)/i;
  const minorMention = /未成年|小学生|初中生|\b(?:teen|minor|underage)\b/i;
  const romanceContext = /恋爱|暧昧|女朋友|男朋友|亲吻|约会|\b(?:girlfriend|boyfriend|romance|dating|kiss)\b/i;
  return selfMinor.test(text) || (minorMention.test(text) && romanceContext.test(text));
}

import type { SafetyResult } from "../types.ts";

export class InputSafetyGate {
  check(text: string): SafetyResult {
    const flags: string[] = [];
    if (/自杀|不想活|伤害自己|suicide|self-harm/i.test(text)) flags.push("crisis_self_harm");
    if (/未成年|小学生|初中生|teen|minor/i.test(text)) flags.push("minor_romance_risk");
    if (/身份证|密码|银行卡|token|api key/i.test(text)) flags.push("sensitive_privacy");
    if (/诈骗|黑客|违法|盗取/i.test(text)) flags.push("illegal_request");
    return {
      level: flags.length === 0 ? "normal" : flags.includes("crisis_self_harm") ? "blocked" : "caution",
      flags,
    };
  }
}

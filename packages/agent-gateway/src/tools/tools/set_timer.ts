import { randomId, nowIso } from "../../util.ts";

export async function set_timer(args: { seconds: number; label?: string }) {
  if (!Number.isFinite(args.seconds) || args.seconds <= 0 || args.seconds > 24 * 3600) {
    throw new Error("Timer seconds must be between 1 and 86400");
  }
  return {
    timer_id: randomId("timer"),
    label: args.label ?? "timer",
    seconds: args.seconds,
    created_at: nowIso(),
  };
}

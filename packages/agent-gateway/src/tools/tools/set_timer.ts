import type { LocalTimerStatus } from "../../types.ts";
import { randomId, nowIso } from "../../util.ts";

const MAX_SECONDS = 24 * 3600;
const MAX_LABEL_LENGTH = 120;
const MAX_ACTIVE_TIMERS = 100;
const MAX_TIMER_HISTORY = 500;

interface InternalTimerRecord extends LocalTimerStatus {
  handle?: ReturnType<typeof setTimeout>;
}

const timers = new Map<string, InternalTimerRecord>();

export async function set_timer(args: { seconds: number; label?: string }): Promise<LocalTimerStatus> {
  const seconds = validateSeconds(args.seconds);
  const label = validateLabel(args.label);
  if (activeTimerCount() >= MAX_ACTIVE_TIMERS) throw new Error("Too many active timers");
  pruneTimerHistory();

  const createdAt = nowIso();
  const fireAt = new Date(Date.now() + seconds * 1000).toISOString();
  const record: InternalTimerRecord = {
    timer_id: randomId("timer"),
    label,
    seconds,
    created_at: createdAt,
    fire_at: fireAt,
    status: "scheduled",
  };
  record.handle = setTimeout(() => {
    record.status = "fired";
    record.fired_at = nowIso();
    record.handle = undefined;
    pruneTimerHistory();
  }, seconds * 1000);
  record.handle.unref?.();
  timers.set(record.timer_id, record);
  return snapshot(record);
}

export function getTimerStatus(timerId: string): LocalTimerStatus | undefined {
  const record = timers.get(timerId);
  return record ? snapshot(record) : undefined;
}

export function listTimerStatuses(): LocalTimerStatus[] {
  return [...timers.values()].map(snapshot);
}

export function resetLocalTimerSchedulerForTests(): void {
  for (const record of timers.values()) {
    if (record.handle) clearTimeout(record.handle);
  }
  timers.clear();
}

function validateSeconds(value: unknown): number {
  if (!Number.isFinite(value) || typeof value !== "number" || value < 1 || value > MAX_SECONDS) {
    throw new Error("Timer seconds must be between 1 and 86400");
  }
  return value;
}

function validateLabel(value: unknown): string {
  if (value === undefined || value === null) return "timer";
  if (typeof value !== "string") throw new Error("Timer label must be a string");
  const trimmed = value.trim() || "timer";
  if (trimmed.length > MAX_LABEL_LENGTH) throw new Error("Timer label must be 120 characters or fewer");
  return trimmed;
}

function activeTimerCount(): number {
  return [...timers.values()].filter((timer) => timer.status === "scheduled").length;
}

function pruneTimerHistory(): void {
  const fired = [...timers.values()].filter((timer) => timer.status === "fired");
  if (fired.length <= MAX_TIMER_HISTORY) return;
  const removeCount = fired.length - MAX_TIMER_HISTORY;
  for (const timer of fired.sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(0, removeCount)) {
    timers.delete(timer.timer_id);
  }
}

function snapshot(record: InternalTimerRecord): LocalTimerStatus {
  return {
    timer_id: record.timer_id,
    label: record.label,
    seconds: record.seconds,
    created_at: record.created_at,
    fire_at: record.fire_at,
    status: record.status,
    fired_at: record.fired_at,
  };
}

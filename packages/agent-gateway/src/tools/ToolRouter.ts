import { ToolPermissionGate } from "../safety/ToolPermissionGate.ts";
import type { LLMToolDefinition, LocalTimerStatus, ToolCallRecord, UserSettings } from "../types.ts";
import { randomId, nowIso } from "../util.ts";
import { get_current_time } from "./tools/get_current_time.ts";
import { getTimerStatus, listTimerStatuses, set_timer, type LocalTimerStoreLike } from "./tools/set_timer.ts";
import { summarize_session } from "./tools/summarize_session.ts";
import { get_user_settings, SettingsStore, type SettingsStoreLike, update_user_settings } from "./tools/settings_tools.ts";

export class ToolRouter {
  readonly settingsStore: SettingsStoreLike;
  private readonly permissionGate: ToolPermissionGate;
  private readonly timerStore?: LocalTimerStoreLike;

  constructor(
    permissionGate = new ToolPermissionGate(),
    settingsStore: SettingsStoreLike = new SettingsStore(),
    timerStore?: LocalTimerStoreLike,
  ) {
    this.permissionGate = permissionGate;
    this.settingsStore = settingsStore;
    this.timerStore = timerStore ?? timerStoreFrom(settingsStore);
  }

  definitions(): LLMToolDefinition[] {
    return [
      {
        type: "function",
        function: {
          name: "get_current_time",
          description: "Get the current date/time for the user's timezone.",
          parameters: {
            type: "object",
            properties: { timezone: { type: "string" } },
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "set_timer",
          description: "Schedule a low-risk local reminder timer. With the local SQLite store it persists across restarts; otherwise it is in-process only. It does not trigger OS notifications yet.",
          parameters: {
            type: "object",
            properties: { seconds: { type: "number", minimum: 1, maximum: 86400 }, label: { type: "string", maxLength: 120 } },
            required: ["seconds"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "summarize_session",
          description: "Summarize recent session messages supplied by the gateway.",
          parameters: {
            type: "object",
            properties: { messages: { type: "array", items: { type: "object" } } },
            required: ["messages"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "get_user_settings",
          description: "Read the current local Liukong profile settings.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      },
      {
        type: "function",
        function: {
          name: "update_user_settings",
          description: "Update low-risk Liukong settings for the current local profile.",
          parameters: {
            type: "object",
            properties: {
              memory_enabled: { type: "boolean" },
              proactive_enabled: { type: "boolean" },
              romance_realism_level: { type: "number" },
              voice_enabled: { type: "boolean" },
              avatar_enabled: { type: "boolean" },
              preferred_name: { type: "string" },
              quiet_hours: { type: "array", items: { type: "string" } },
              adult_romance_enabled: { type: "boolean" },
            },
            additionalProperties: false,
          },
        },
      },
    ].filter((definition) => this.permissionGate.isAllowed(definition.function.name));
  }

  getTimerStatus(timerId: string, userId = "default"): LocalTimerStatus | undefined {
    return this.timerStore?.getLocalTimerStatus(userId, timerId) ?? getTimerStatus(timerId);
  }

  listTimerStatuses(userId = "default"): LocalTimerStatus[] {
    return this.timerStore?.listLocalTimerStatuses(userId) ?? listTimerStatuses();
  }

  async execute(params: {
    request_id: string;
    user_id: string;
    tool_name: string;
    arguments_json: Record<string, unknown>;
  }): Promise<{ record: ToolCallRecord; result?: unknown }> {
    const allowed = this.permissionGate.isAllowed(params.tool_name);
    const record: ToolCallRecord = {
      id: randomId("tool"),
      request_id: params.request_id,
      user_id: params.user_id,
      tool_name: params.tool_name,
      arguments_json: params.arguments_json,
      allowed,
      created_at: nowIso(),
    };
    if (!allowed) {
      record.result_summary = "denied by ToolPermissionGate";
      return { record };
    }

    const result = await this.dispatch(params.tool_name, params.arguments_json, params.user_id);
    record.result_summary = JSON.stringify(result).slice(0, 500);
    return { record, result };
  }

  private async dispatch(toolName: string, args: Record<string, unknown>, userId: string): Promise<unknown> {
    switch (toolName) {
      case "get_current_time":
        return get_current_time(args as { timezone?: string });
      case "set_timer":
        return set_timer(args as { seconds: number; label?: string }, { userId, store: this.timerStore });
      case "summarize_session":
        return summarize_session(args as any);
      case "get_user_settings":
        return get_user_settings({ user_id: userId }, this.settingsStore);
      case "update_user_settings":
        return update_user_settings({ user_id: userId, patch: sanitizeSettingsToolPatch(args) }, this.settingsStore);
      default:
        throw new Error(`Unsupported tool: ${toolName}`);
    }
  }
}

function timerStoreFrom(value: unknown): LocalTimerStoreLike | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<LocalTimerStoreLike>;
  return typeof candidate.createLocalTimer === "function"
    && typeof candidate.getLocalTimerStatus === "function"
    && typeof candidate.listLocalTimerStatuses === "function"
    ? candidate as LocalTimerStoreLike
    : undefined;
}

function sanitizeSettingsToolPatch(args: Record<string, unknown>): Partial<UserSettings> {
  const patch: Partial<UserSettings> = {};
  if (typeof args.memory_enabled === "boolean") patch.memory_enabled = args.memory_enabled;
  if (typeof args.proactive_enabled === "boolean") patch.proactive_enabled = args.proactive_enabled;
  if (typeof args.voice_enabled === "boolean") patch.voice_enabled = args.voice_enabled;
  if (typeof args.avatar_enabled === "boolean") patch.avatar_enabled = args.avatar_enabled;
  if (typeof args.adult_romance_enabled === "boolean") patch.adult_romance_enabled = args.adult_romance_enabled;
  if (typeof args.romance_realism_level === "number" && Number.isFinite(args.romance_realism_level)) {
    patch.romance_realism_level = Math.min(2, Math.max(0, args.romance_realism_level));
  }
  if (typeof args.preferred_name === "string" && args.preferred_name.length <= 80) {
    patch.preferred_name = args.preferred_name.trim() || undefined;
  }
  if (Array.isArray(args.quiet_hours) && args.quiet_hours.every((value) => typeof value === "string" && value.length <= 20)) {
    patch.quiet_hours = args.quiet_hours;
  }
  return patch;
}

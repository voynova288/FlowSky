import { ToolPermissionGate } from "../safety/ToolPermissionGate.ts";
import type { ToolCallRecord } from "../types.ts";
import { randomId, nowIso } from "../util.ts";
import { get_current_time } from "./tools/get_current_time.ts";
import { set_timer } from "./tools/set_timer.ts";
import { summarize_session } from "./tools/summarize_session.ts";
import { get_user_settings, SettingsStore, type SettingsStoreLike, update_user_settings } from "./tools/settings_tools.ts";

export class ToolRouter {
  readonly settingsStore: SettingsStoreLike;
  private readonly permissionGate: ToolPermissionGate;

  constructor(
    permissionGate = new ToolPermissionGate(),
    settingsStore: SettingsStoreLike = new SettingsStore(),
  ) {
    this.permissionGate = permissionGate;
    this.settingsStore = settingsStore;
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
        return set_timer(args as { seconds: number; label?: string });
      case "summarize_session":
        return summarize_session(args as any);
      case "get_user_settings":
        return get_user_settings({ user_id: userId }, this.settingsStore);
      case "update_user_settings":
        return update_user_settings({ user_id: userId, patch: args as any }, this.settingsStore);
      default:
        throw new Error(`Unsupported tool: ${toolName}`);
    }
  }
}

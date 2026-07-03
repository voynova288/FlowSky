const DEFAULT_ALLOWED_TOOLS = new Set([
  "get_current_time",
  "set_timer",
  "summarize_session",
  "get_user_settings",
  "update_user_settings",
]);

const FORBIDDEN_TOOL_PATTERNS = [/shell/i, /filesystem/i, /gmail/i, /contacts/i, /browser_history/i, /payment/i, /auto_send_message/i];

export class ToolPermissionGate {
  private readonly allowedTools: Set<string>;

  constructor(allowedTools = DEFAULT_ALLOWED_TOOLS) {
    this.allowedTools = allowedTools;
  }

  isAllowed(toolName: string): boolean {
    if (FORBIDDEN_TOOL_PATTERNS.some((pattern) => pattern.test(toolName))) return false;
    return this.allowedTools.has(toolName);
  }
}

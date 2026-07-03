export interface RequestLogEntry {
  request_id: string;
  user_id: string;
  session_id: string;
  model: string;
  thinking_type?: string;
  prompt_hash?: string;
  retrieved_memory_ids: string[];
  tool_calls: string[];
  first_token_latency?: number;
  total_latency: number;
  usage: unknown;
  safety_flags: string[];
  error_code?: string;
}

export class RequestLogger {
  readonly entries: RequestLogEntry[] = [];

  record(entry: RequestLogEntry): void {
    // Never store full prompts, raw user secrets, or API keys here.
    this.entries.push(entry);
  }
}

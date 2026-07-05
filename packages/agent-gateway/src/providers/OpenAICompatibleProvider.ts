import type { LLMProvider } from "./LLMProvider.ts";
import type { LLMCompleteRequest, LLMResponse, LLMStreamChunk, LLMStreamRequest, LLMToolCall, Usage } from "../types.ts";

export interface OpenAICompatibleProviderOptions {
  apiKey?: string;
  baseUrl: string;
  providerName?: string;
  fetchFn?: typeof fetch;
  logger?: Pick<Console, "error" | "warn" | "log">;
  requireApiKey?: boolean;
}

export class OpenAICompatibleProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly providerName: string;
  private readonly fetchFn: typeof fetch;
  private readonly logger?: Pick<Console, "error" | "warn" | "log">;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.apiKey = options.apiKey ?? "";
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.providerName = options.providerName ?? "openai-compatible";
    this.fetchFn = options.fetchFn ?? fetch;
    this.logger = options.logger;
    if (!this.apiKey && options.requireApiKey !== false) throw new Error("missing_provider_key");
  }

  async complete(request: LLMCompleteRequest): Promise<LLMResponse> {
    const payload = { ...request, stream: false };
    const json = await this.postJson(payload);
    const message = json.choices?.[0]?.message ?? {};
    const text = message.content ?? "";
    return {
      text,
      usage: normalizeUsage(json.usage),
      tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : undefined,
      raw: json,
    };
  }

  async *stream(request: LLMStreamRequest): AsyncIterable<LLMStreamChunk> {
    const response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ ...request, stream: true }),
    });
    await this.assertOk(response);
    if (!response.body) return;

    const decoder = new TextDecoder();
    let buffer = "";
    const toolCallFragments = new Map<number, ToolCallFragment>();
    let emittedToolCalls = false;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseSseLine(line);
        if (!parsed) continue;
        if (parsed === "[DONE]") {
          const toolCalls = assembleToolCalls(toolCallFragments);
          if (toolCalls.length && !emittedToolCalls) yield { tool_calls: toolCalls };
          yield { done: true };
          return;
        }
        const choice = parsed.choices?.[0] ?? {};
        const deltaObject = choice.delta ?? {};
        accumulateToolCalls(toolCallFragments, deltaObject.tool_calls);
        const delta = deltaObject.content ?? "";
        const usage = parsed.usage ? normalizeUsage(parsed.usage) : undefined;
        if (delta || usage) yield { delta, usage, raw: parsed };
        if (choice.finish_reason === "tool_calls") {
          const toolCalls = assembleToolCalls(toolCallFragments);
          if (toolCalls.length && !emittedToolCalls) {
            yield { tool_calls: toolCalls, raw: parsed };
            emittedToolCalls = true;
          }
        }
      }
    }
  }

  private async postJson(payload: Record<string, unknown>): Promise<any> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(payload),
      });
      await this.assertOk(response);
      return await response.json();
    } catch (error) {
      const message = sanitizeForLog(error, this.apiKey);
      this.logger?.error?.(`${this.providerName} provider error: ${message}`);
      throw new Error(message);
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  private async assertOk(response: Response): Promise<void> {
    if (response.ok) return;
    const body = await response.text().catch(() => "");
    throw new Error(`${this.providerName} API error ${response.status}: ${sanitizeForLog(body, this.apiKey)}`);
  }
}

interface ToolCallFragment {
  id?: string;
  type?: "function";
  function: {
    name?: string;
    arguments: string;
  };
}

function accumulateToolCalls(target: Map<number, ToolCallFragment>, rawToolCalls: unknown): void {
  if (!Array.isArray(rawToolCalls)) return;
  for (const raw of rawToolCalls) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as any;
    const index = Number.isInteger(item.index) ? item.index : target.size;
    const current = target.get(index) ?? { function: { arguments: "" } };
    if (typeof item.id === "string") current.id = item.id;
    if (item.type === "function") current.type = "function";
    if (item.function && typeof item.function === "object") {
      if (typeof item.function.name === "string") current.function.name = item.function.name;
      if (typeof item.function.arguments === "string") current.function.arguments += item.function.arguments;
    }
    target.set(index, current);
  }
}

function assembleToolCalls(fragments: Map<number, ToolCallFragment>): LLMToolCall[] {
  return [...fragments.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, item]) => item.id && item.function.name)
    .map(([, item]) => ({
      id: item.id!,
      type: "function",
      function: {
        name: item.function.name!,
        arguments: item.function.arguments,
      },
    }));
}

function parseSseLine(line: string): any | "[DONE]" | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":")) return null;
  if (!trimmed.startsWith("data:")) return null;
  const data = trimmed.slice(5).trim();
  if (data === "[DONE]") return "[DONE]";
  return JSON.parse(data);
}

function normalizeUsage(usage: any): Usage {
  return {
    prompt_tokens: Number(usage?.prompt_tokens ?? 0),
    completion_tokens: Number(usage?.completion_tokens ?? 0),
    total_tokens: usage?.total_tokens === undefined ? undefined : Number(usage.total_tokens),
  };
}

export function sanitizeForLog(error: unknown, apiKey: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  let redacted = raw;
  if (apiKey) redacted = redacted.replaceAll(apiKey, "[REDACTED_PROVIDER_API_KEY]");
  redacted = redacted.replace(/sk-[A-Za-z0-9_-]{12,}/g, "[REDACTED_API_KEY]");
  return redacted;
}

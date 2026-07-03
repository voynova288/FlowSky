import type { LLMProvider } from "./LLMProvider.ts";
import { DEEPSEEK_BASE_URL } from "./model-config.ts";
import type { LLMCompleteRequest, LLMResponse, LLMStreamChunk, LLMStreamRequest, Usage } from "../types.ts";

export interface DeepSeekProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  logger?: Pick<Console, "error" | "warn" | "log">;
}

export class DeepSeekProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly logger?: Pick<Console, "error" | "warn" | "log">;

  constructor(options: DeepSeekProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "";
    this.baseUrl = (options.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? process.env.LIUKONG_DEEPSEEK_BASE_URL ?? DEEPSEEK_BASE_URL).replace(/\/$/, "");
    this.fetchFn = options.fetchFn ?? fetch;
    this.logger = options.logger;
    if (!this.apiKey) {
      throw new Error("missing_provider_key");
    }
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
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseSseLine(line);
        if (!parsed) continue;
        if (parsed === "[DONE]") {
          yield { done: true };
          return;
        }
        const delta = parsed.choices?.[0]?.delta?.content ?? "";
        const usage = parsed.usage ? normalizeUsage(parsed.usage) : undefined;
        yield { delta, usage, raw: parsed };
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
      this.logger?.error?.(`DeepSeekProvider error: ${message}`);
      throw new Error(message);
    }
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`,
    };
  }

  private async assertOk(response: Response): Promise<void> {
    if (response.ok) return;
    const body = await response.text().catch(() => "");
    throw new Error(
      `DeepSeek API error ${response.status}: ${sanitizeForLog(body, this.apiKey)}`,
    );
  }
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
  if (apiKey) redacted = redacted.replaceAll(apiKey, "[REDACTED_DEEPSEEK_API_KEY]");
  redacted = redacted.replace(/sk-[A-Za-z0-9_-]{12,}/g, "[REDACTED_API_KEY]");
  return redacted;
}

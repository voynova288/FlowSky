import { OpenAICompatibleProvider, sanitizeForLog } from "./OpenAICompatibleProvider.ts";
import { DEEPSEEK_BASE_URL } from "./model-config.ts";

export interface DeepSeekProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  logger?: Pick<Console, "error" | "warn" | "log">;
}

export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(options: DeepSeekProviderOptions = {}) {
    super({
      providerName: "DeepSeek",
      apiKey: options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "",
      baseUrl: options.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? process.env.LIUKONG_DEEPSEEK_BASE_URL ?? DEEPSEEK_BASE_URL,
      fetchFn: options.fetchFn,
      logger: options.logger,
    });
  }
}

export { sanitizeForLog };

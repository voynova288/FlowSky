import { LocalCharacterStore } from "../character/LocalCharacterStore.ts";
import { AgentGateway } from "../gateway/AgentGateway.ts";
import { MemoryController } from "../memory/MemoryController.ts";
import { ToolPermissionGate } from "../safety/ToolPermissionGate.ts";
import { PromptAssembler } from "../prompts/PromptAssembler.ts";
import { SqliteRequestLogger } from "../storage/SqliteRequestLogger.ts";
import { SqliteStateStore } from "../storage/SqliteStateStore.ts";
import { ToolRouter } from "../tools/ToolRouter.ts";
import type { LLMCompleteRequest, LLMResponse, LLMStreamChunk, LLMStreamRequest } from "../types.ts";
import type { LLMProvider } from "./LLMProvider.ts";
import { DeepSeekProvider } from "./DeepSeekProvider.ts";
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider.ts";
import { DEEPSEEK_BASE_URL, normalizeProviderName, OLLAMA_BASE_URL, OPENAI_BASE_URL, type LLMProviderName } from "./model-config.ts";

export interface DefaultAgentGatewayOptions {
  apiKey?: string;
  providerName?: LLMProviderName | string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  stateStore?: SqliteStateStore;
  provider?: LLMProvider;
  allowMissingApiKey?: boolean;
}

export interface ResolvedProviderConfig {
  providerName: LLMProviderName;
  apiKey?: string;
  baseUrl: string;
}

export function createDefaultAgentGateway(options: DefaultAgentGatewayOptions = {}): AgentGateway {
  const stateStore = options.stateStore ?? new SqliteStateStore();
  const providerName = normalizeProviderName(options.providerName);
  const provider = options.provider ?? createDefaultProvider({ ...options, providerName });
  const characterStore = new LocalCharacterStore();
  return new AgentGateway({
    provider,
    modelProviderName: providerName,
    promptAssembler: new PromptAssembler({ characterStore }),
    memoryController: new MemoryController({ store: stateStore }),
    toolRouter: new ToolRouter(new ToolPermissionGate(), stateStore),
    requestLogger: new SqliteRequestLogger(stateStore),
    conversationStore: stateStore,
  });
}

export function createDefaultProvider(options: DefaultAgentGatewayOptions = {}): LLMProvider {
  const config = resolveProviderConfig(options);
  if (!config.apiKey && config.providerName !== "ollama") {
    if (options.allowMissingApiKey) return new MissingProviderKeyProvider();
    throw new Error("missing_provider_key");
  }
  if (config.providerName === "openai") {
    return new OpenAICompatibleProvider({
      providerName: "OpenAI",
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      fetchFn: options.fetchFn,
    });
  }
  if (config.providerName === "ollama") {
    return new OpenAICompatibleProvider({
      providerName: "Ollama",
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      requireApiKey: false,
      fetchFn: options.fetchFn,
    });
  }
  return new DeepSeekProvider({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    fetchFn: options.fetchFn,
  });
}

export function resolveProviderConfig(options: DefaultAgentGatewayOptions = {}): ResolvedProviderConfig {
  const providerName = normalizeProviderName(options.providerName);
  if (providerName === "openai") {
    return {
      providerName,
      apiKey: options.apiKey ?? process.env.LIUKONG_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
      baseUrl: (options.baseUrl ?? process.env.LIUKONG_OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL ?? OPENAI_BASE_URL).replace(/\/$/, ""),
    };
  }
  if (providerName === "ollama") {
    return {
      providerName,
      apiKey: options.apiKey ?? process.env.LIUKONG_OLLAMA_API_KEY ?? process.env.OLLAMA_API_KEY,
      baseUrl: (options.baseUrl ?? process.env.LIUKONG_OLLAMA_BASE_URL ?? process.env.OLLAMA_BASE_URL ?? OLLAMA_BASE_URL).replace(/\/$/, ""),
    };
  }
  return {
    providerName,
    apiKey: options.apiKey ?? process.env.DEEPSEEK_API_KEY,
    baseUrl: (options.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? process.env.LIUKONG_DEEPSEEK_BASE_URL ?? DEEPSEEK_BASE_URL).replace(/\/$/, ""),
  };
}

class MissingProviderKeyProvider implements LLMProvider {
  async complete(_request: LLMCompleteRequest): Promise<LLMResponse> {
    throw new Error("missing_provider_key");
  }

  async *stream(_request: LLMStreamRequest): AsyncIterable<LLMStreamChunk> {
    throw new Error("missing_provider_key");
  }
}

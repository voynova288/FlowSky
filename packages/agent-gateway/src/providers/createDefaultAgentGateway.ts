import { AgentGateway } from "../gateway/AgentGateway.ts";
import { MemoryController } from "../memory/MemoryController.ts";
import { ToolPermissionGate } from "../safety/ToolPermissionGate.ts";
import { SqliteRequestLogger } from "../storage/SqliteRequestLogger.ts";
import { SqliteStateStore } from "../storage/SqliteStateStore.ts";
import { ToolRouter } from "../tools/ToolRouter.ts";
import type { LLMCompleteRequest, LLMResponse, LLMStreamChunk, LLMStreamRequest } from "../types.ts";
import type { LLMProvider } from "./LLMProvider.ts";
import { DeepSeekProvider } from "./DeepSeekProvider.ts";

export interface DefaultAgentGatewayOptions {
  apiKey?: string;
  stateStore?: SqliteStateStore;
  provider?: LLMProvider;
  allowMissingApiKey?: boolean;
}

export function createDefaultAgentGateway(options: DefaultAgentGatewayOptions = {}): AgentGateway {
  const stateStore = options.stateStore ?? new SqliteStateStore();
  const provider = options.provider ?? createDefaultProvider(options);
  return new AgentGateway({
    provider,
    memoryController: new MemoryController({ store: stateStore }),
    toolRouter: new ToolRouter(new ToolPermissionGate(), stateStore),
    requestLogger: new SqliteRequestLogger(stateStore),
    conversationStore: stateStore,
  });
}

function createDefaultProvider(options: DefaultAgentGatewayOptions): LLMProvider {
  const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
  if (apiKey) return new DeepSeekProvider({ apiKey });
  if (options.allowMissingApiKey) return new MissingProviderKeyProvider();
  return new DeepSeekProvider();
}

class MissingProviderKeyProvider implements LLMProvider {
  async complete(_request: LLMCompleteRequest): Promise<LLMResponse> {
    throw new Error("missing_provider_key");
  }

  async *stream(_request: LLMStreamRequest): AsyncIterable<LLMStreamChunk> {
    throw new Error("missing_provider_key");
  }
}

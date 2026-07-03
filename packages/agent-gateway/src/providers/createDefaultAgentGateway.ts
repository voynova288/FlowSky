import { AgentGateway } from "../gateway/AgentGateway.ts";
import { MemoryController } from "../memory/MemoryController.ts";
import { ToolPermissionGate } from "../safety/ToolPermissionGate.ts";
import { SqliteRequestLogger } from "../storage/SqliteRequestLogger.ts";
import { SqliteStateStore } from "../storage/SqliteStateStore.ts";
import { ToolRouter } from "../tools/ToolRouter.ts";
import { DeepSeekProvider } from "./DeepSeekProvider.ts";

export function createDefaultAgentGateway(): AgentGateway {
  const stateStore = new SqliteStateStore();
  return new AgentGateway({
    provider: new DeepSeekProvider(),
    memoryController: new MemoryController({ store: stateStore }),
    toolRouter: new ToolRouter(new ToolPermissionGate(), stateStore),
    requestLogger: new SqliteRequestLogger(stateStore),
  });
}

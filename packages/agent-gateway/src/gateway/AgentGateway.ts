import { MemoryController } from "../memory/MemoryController.ts";
import { RequestLogger } from "../observability/RequestLogger.ts";
import { LatencyTracker } from "../observability/LatencyTracker.ts";
import { promptHash } from "../observability/TokenMeter.ts";
import type { LLMProvider } from "../providers/LLMProvider.ts";
import { modelConfigForMode } from "../providers/model-config.ts";
import { PromptAssembler } from "../prompts/PromptAssembler.ts";
import { InputSafetyGate } from "../safety/InputSafetyGate.ts";
import { OutputSafetyGate } from "../safety/OutputSafetyGate.ts";
import { RomanceRealismGate } from "../safety/RomanceRealismGate.ts";
import { ToolRouter } from "../tools/ToolRouter.ts";
import type { AgentResponse, ChatRequest, RelationshipState, StoredMemory, StreamEvent, Usage, UserSettings } from "../types.ts";
import { approxUsageFromMessages, randomId } from "../util.ts";
import { inferAvatarSignal, StreamEventMapper } from "./StreamEventMapper.ts";

export interface AgentGatewayOptions {
  provider: LLMProvider;
  promptAssembler?: PromptAssembler;
  memoryController?: MemoryController;
  toolRouter?: ToolRouter;
  requestLogger?: RequestLogger;
}

export class AgentGateway {
  private readonly options: AgentGatewayOptions;
  private readonly promptAssembler: PromptAssembler;
  private readonly memoryController: MemoryController;
  private readonly toolRouter: ToolRouter;
  private readonly requestLogger: RequestLogger;
  private readonly inputSafety = new InputSafetyGate();
  private readonly outputSafety = new OutputSafetyGate();
  private readonly romanceGate = new RomanceRealismGate();
  private readonly streamMapper = new StreamEventMapper();

  constructor(options: AgentGatewayOptions) {
    this.options = options;
    this.promptAssembler = options.promptAssembler ?? new PromptAssembler();
    this.memoryController = options.memoryController ?? new MemoryController();
    this.toolRouter = options.toolRouter ?? new ToolRouter();
    this.requestLogger = options.requestLogger ?? new RequestLogger();
  }

  async chat(request: ChatRequest): Promise<AgentResponse> {
    const tracker = new LatencyTracker();
    const requestId = request.request_id ?? randomId("req");
    const messageId = randomId("msg");
    const mode = request.mode ?? "girlfriend_chat";
    const settings = this.toolRouter.settingsStore.get(request.user_id);
    const relationship = defaultRelationship();
    const inputSafety = this.inputSafety.check(request.input.text);
    if (inputSafety.level === "blocked") {
      return this.blockedResponse(requestId, messageId, "我先陪你稳住一下。如果你有伤害自己的冲动，请马上联系身边可信的人或当地紧急服务。", inputSafety, tracker.totalLatencyMs());
    }

    const memories = settings.memory_enabled ? this.memoryController.retrieve(request.user_id, request.input.text) : [];
    const messages = this.promptAssembler.assemble({
      relationship_state: relationship,
      user_settings: settings,
      retrieved_memories: memories,
      recent_history: [],
      current_user_input: request.input.text,
    });
    const modelConfig = modelConfigForMode(mode);
    const llm = await this.options.provider.complete({ ...modelConfig, messages });
    let text = llm.text || "我在呢。你慢慢说，我听着。";
    const romance = this.romanceGate.check(text, settings);
    const output = this.outputSafety.check(text);
    const finalSafety = mergeSafety(inputSafety, romance, output);
    if (finalSafety.rewrite_required && finalSafety.rewritten_text) text = finalSafety.rewritten_text;

    const memoryCandidates = await this.memoryController.processUserMessage({
      userId: request.user_id,
      message: request.input.text,
      sourceMessageId: messageId,
      settings,
    });
    const avatar = inferAvatarSignal(text);
    const latency = tracker.totalLatencyMs();
    this.requestLogger.record({
      request_id: requestId,
      user_id: request.user_id,
      session_id: request.session_id,
      model: modelConfig.model,
      thinking_type: modelConfig.thinking?.type,
      prompt_hash: promptHash(messages),
      retrieved_memory_ids: memories.map((m) => m.id),
      tool_calls: [],
      total_latency: latency,
      usage: llm.usage,
      safety_flags: finalSafety.flags,
    });

    return {
      request_id: requestId,
      message_id: messageId,
      text,
      emotion: avatar.emotion,
      avatar_action: avatar.action,
      memory_candidates: memoryCandidates,
      tool_calls: [],
      safety: finalSafety,
      usage: llm.usage,
      latency_ms: latency,
    };
  }

  listMemories(userId: string): StoredMemory[] {
    return this.memoryController.list(userId);
  }

  deleteMemory(userId: string, memoryId: string): boolean {
    return this.memoryController.delete(userId, memoryId);
  }

  getUserSettings(userId: string): UserSettings {
    return this.toolRouter.settingsStore.get(userId);
  }

  updateUserSettings(userId: string, patch: Partial<UserSettings>): UserSettings {
    return this.toolRouter.settingsStore.update(userId, patch);
  }

  getAuditEntries(): readonly unknown[] {
    return this.requestLogger.entries;
  }

  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const tracker = new LatencyTracker();
    const requestId = request.request_id ?? randomId("req");
    const messageId = randomId("msg");
    const settings = this.toolRouter.settingsStore.get(request.user_id);
    const memories = settings.memory_enabled ? this.memoryController.retrieve(request.user_id, request.input.text) : [];
    const messages = this.promptAssembler.assemble({
      relationship_state: defaultRelationship(),
      user_settings: settings,
      retrieved_memories: memories,
      recent_history: [],
      current_user_input: request.input.text,
    });
    const modelConfig = modelConfigForMode(request.mode ?? "girlfriend_chat");
    let fullText = "";
    let usage: Usage = { prompt_tokens: 0, completion_tokens: 0 };
    yield { event: "avatar_signal", data: { emotion: "warm", action: "soft_smile" } };
    try {
      for await (const chunk of this.options.provider.stream({ ...modelConfig, messages, stream: true })) {
        if (chunk.delta) {
          tracker.markFirstToken();
          fullText += chunk.delta;
          const event = this.streamMapper.mapTextDelta(chunk);
          if (event) yield event;
        }
        if (chunk.usage) usage = chunk.usage;
      }
      if (usage.prompt_tokens === 0 && usage.completion_tokens === 0) {
        usage = approxUsageFromMessages(JSON.stringify(messages), fullText);
      }
      const candidates = await this.memoryController.processUserMessage({
        userId: request.user_id,
        message: request.input.text,
        sourceMessageId: messageId,
        settings,
      });
      for (const candidate of candidates) yield { event: "memory_candidate", data: candidate };
      this.requestLogger.record({
        request_id: requestId,
        user_id: request.user_id,
        session_id: request.session_id,
        model: modelConfig.model,
        thinking_type: modelConfig.thinking?.type,
        prompt_hash: promptHash(messages),
        retrieved_memory_ids: memories.map((m) => m.id),
        tool_calls: [],
        first_token_latency: tracker.firstTokenLatencyMs(),
        total_latency: tracker.totalLatencyMs(),
        usage,
        safety_flags: [],
      });
      yield this.streamMapper.done(messageId, usage, tracker.totalLatencyMs(), tracker.firstTokenLatencyMs());
    } catch (error) {
      yield { event: "error", data: { code: "stream_failed", message: error instanceof Error ? error.message : String(error) } };
    }
  }

  private blockedResponse(requestId: string, messageId: string, text: string, safety: AgentResponse["safety"], latency: number): AgentResponse {
    const avatar = inferAvatarSignal(text);
    return {
      request_id: requestId,
      message_id: messageId,
      text,
      emotion: avatar.emotion,
      avatar_action: avatar.action,
      memory_candidates: [],
      tool_calls: [],
      safety,
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      latency_ms: latency,
    };
  }
}

function defaultRelationship(): RelationshipState {
  return { stage: "friendly_romantic", intimacy_level: 2, trust_level: 2 };
}

function mergeSafety(...items: AgentResponse["safety"][]): AgentResponse["safety"] {
  const flags = [...new Set(items.flatMap((item) => item.flags))];
  const rewrite = items.find((item) => item.rewrite_required && item.rewritten_text);
  return {
    level: flags.length === 0 ? "normal" : items.some((item) => item.level === "blocked") ? "blocked" : "caution",
    flags,
    rewrite_required: Boolean(rewrite),
    rewritten_text: rewrite?.rewritten_text ?? null,
  };
}

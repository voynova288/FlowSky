import { inferEmotionalState, shouldPersistEmotionalState } from "../emotion/EmotionTracker.ts";
import { MemoryController } from "../memory/MemoryController.ts";
import { RequestLogger } from "../observability/RequestLogger.ts";
import { LatencyTracker } from "../observability/LatencyTracker.ts";
import { promptHash } from "../observability/TokenMeter.ts";
import type { LLMProvider } from "../providers/LLMProvider.ts";
import { modelConfigForMode, type LLMProviderName } from "../providers/model-config.ts";
import { PromptAssembler } from "../prompts/PromptAssembler.ts";
import { InputSafetyGate } from "../safety/InputSafetyGate.ts";
import { OutputSafetyGate } from "../safety/OutputSafetyGate.ts";
import { RomanceRealismGate } from "../safety/RomanceRealismGate.ts";
import { ToolRouter } from "../tools/ToolRouter.ts";
import type { AgentResponse, ChatRequest, EmotionalState, LLMMessage, LLMStreamChunk, LLMToolCall, RelationshipState, StoredMemory, StreamEvent, ToolCallRecord, Usage, UserSettings } from "../types.ts";
import { approxUsageFromMessages, nowIso, randomId } from "../util.ts";
import { inferAvatarSignal, StreamEventMapper } from "./StreamEventMapper.ts";

export interface ConversationStoreLike {
  recentMessages?(userId: string, sessionId: string, limit?: number): LLMMessage[];
  saveMessage?(params: {
    id: string;
    session_id: string;
    user_id: string;
    role: "user" | "assistant";
    content: string;
    emotion?: string;
    avatar_action?: string;
  }): void;
  recordToolCall?(record: ToolCallRecord): void;
  getRelationshipState?(userId: string): RelationshipState | null;
  getEmotionalState?(userId: string): EmotionalState | null;
  saveEmotionalState?(userId: string, emotionalState: EmotionalState): EmotionalState;
}

export interface AgentGatewayOptions {
  provider: LLMProvider;
  modelProviderName?: LLMProviderName;
  promptAssembler?: PromptAssembler;
  memoryController?: MemoryController;
  toolRouter?: ToolRouter;
  requestLogger?: RequestLogger;
  conversationStore?: ConversationStoreLike;
}

export class AgentGateway {
  private readonly options: AgentGatewayOptions;
  private readonly promptAssembler: PromptAssembler;
  private readonly memoryController: MemoryController;
  private readonly toolRouter: ToolRouter;
  private readonly requestLogger: RequestLogger;
  private readonly conversationStore?: ConversationStoreLike;
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
    this.conversationStore = options.conversationStore;
  }

  async chat(request: ChatRequest): Promise<AgentResponse> {
    const tracker = new LatencyTracker();
    const requestId = request.request_id ?? randomId("req");
    const messageId = randomId("msg");
    const userMessageId = randomId("msg");
    const mode = request.mode ?? "girlfriend_chat";
    const settings = this.toolRouter.settingsStore.get(request.user_id);
    const inputSafety = this.inputSafety.check(request.input.text);
    if (inputSafety.level === "blocked") {
      return this.blockedResponse(requestId, messageId, blockedInputText(inputSafety), inputSafety, tracker.totalLatencyMs());
    }

    const memories = settings.memory_enabled ? this.memoryController.retrieve(request.user_id, request.input.text) : [];
    const recentHistory = this.conversationStore?.recentMessages?.(request.user_id, request.session_id, 12) ?? [];
    const previousEmotionalState = this.conversationStore?.getEmotionalState?.(request.user_id) ?? null;
    const emotionalState = inferEmotionalState(request.input.text, previousEmotionalState, userMessageId);
    const messages = this.promptAssembler.assemble({
      relationship_state: this.relationshipFor(request.user_id),
      user_emotional_state: emotionalState,
      user_settings: settings,
      retrieved_memories: memories,
      recent_history: recentHistory,
      current_user_input: request.input.text,
    });
    const modelConfig = modelConfigForMode(mode, this.options.modelProviderName ?? "deepseek");
    const toolRecords: ToolCallRecord[] = [];
    let llm = await this.options.provider.complete({
      ...modelConfig,
      messages,
      tools: this.toolRouter.definitions(),
      tool_choice: "auto",
    });
    if (llm.tool_calls?.length) {
      const toolMessages = await this.executeToolCalls({
        calls: llm.tool_calls,
        requestId,
        userId: request.user_id,
      });
      toolRecords.push(...toolMessages.records);
      for (const record of toolMessages.records) this.conversationStore?.recordToolCall?.(record);
      const followUpMessages: LLMMessage[] = [
        ...messages,
        { role: "assistant", content: llm.text ?? "", tool_calls: llm.tool_calls },
        ...toolMessages.messages,
      ];
      llm = await this.options.provider.complete({
        ...modelConfig,
        messages: followUpMessages,
        tool_choice: "none",
      });
    }

    let text = llm.text || "我在呢。你慢慢说，我听着。";
    const romance = this.romanceGate.check(text, settings);
    const output = this.outputSafety.check(text);
    const finalSafety = mergeSafety(inputSafety, romance, output);
    if (finalSafety.rewrite_required && finalSafety.rewritten_text) text = finalSafety.rewritten_text;

    const memoryCandidates = await this.memoryController.processUserMessage({
      userId: request.user_id,
      message: request.input.text,
      sourceMessageId: userMessageId,
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
      tool_calls: toolRecords.map((record) => record.id),
      total_latency: latency,
      usage: llm.usage,
      safety_flags: finalSafety.flags,
    });
    if (shouldPersistEmotionalState(emotionalState, previousEmotionalState)) this.conversationStore?.saveEmotionalState?.(request.user_id, emotionalState);
    this.conversationStore?.saveMessage?.({
      id: userMessageId,
      session_id: request.session_id,
      user_id: request.user_id,
      role: "user",
      content: request.input.text,
    });
    this.conversationStore?.saveMessage?.({
      id: messageId,
      session_id: request.session_id,
      user_id: request.user_id,
      role: "assistant",
      content: text,
      emotion: avatar.emotion,
      avatar_action: avatar.action,
    });

    return {
      request_id: requestId,
      message_id: messageId,
      text,
      emotion: avatar.emotion,
      avatar_action: avatar.action,
      memory_candidates: memoryCandidates,
      tool_calls: toolRecords,
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

  confirmMemory(
    userId: string,
    memoryId: string,
    patch: Partial<Pick<StoredMemory, "content" | "memory_type">> = {},
  ): StoredMemory | null {
    return this.memoryController.confirm(userId, memoryId, patch);
  }

  rejectMemory(userId: string, memoryId: string): boolean {
    return this.memoryController.reject(userId, memoryId);
  }

  updateMemory(
    userId: string,
    memoryId: string,
    patch: Partial<Pick<StoredMemory, "content" | "memory_type">>,
  ): StoredMemory | null {
    return this.memoryController.updateMemory(userId, memoryId, patch);
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
    const userMessageId = randomId("msg");
    const settings = this.toolRouter.settingsStore.get(request.user_id);
    const inputSafety = this.inputSafety.check(request.input.text);
    if (inputSafety.level === "blocked") {
      const usage: Usage = { prompt_tokens: 0, completion_tokens: 0 };
      const text = blockedInputText(inputSafety);
      yield { event: "avatar_signal", data: inferAvatarSignal(text) };
      yield { event: "text_delta", data: { delta: text } };
      yield this.streamMapper.done(messageId, usage, tracker.totalLatencyMs(), tracker.firstTokenLatencyMs());
      return;
    }

    const memories = settings.memory_enabled ? this.memoryController.retrieve(request.user_id, request.input.text) : [];
    const recentHistory = this.conversationStore?.recentMessages?.(request.user_id, request.session_id, 12) ?? [];
    const previousEmotionalState = this.conversationStore?.getEmotionalState?.(request.user_id) ?? null;
    const emotionalState = inferEmotionalState(request.input.text, previousEmotionalState, userMessageId);
    const messages = this.promptAssembler.assemble({
      relationship_state: this.relationshipFor(request.user_id),
      user_emotional_state: emotionalState,
      user_settings: settings,
      retrieved_memories: memories,
      recent_history: recentHistory,
      current_user_input: request.input.text,
    });
    const modelConfig = modelConfigForMode(request.mode ?? "girlfriend_chat", this.options.modelProviderName ?? "deepseek");
    const toolRecords: ToolCallRecord[] = [];
    try {
      // Buffer provider tokens until output/romance gates pass. This trades a
      // little latency for preventing unsafe text from being streamed and then
      // retracted.
      const initial = await this.bufferProviderStream(
        this.options.provider.stream({
          ...modelConfig,
          messages,
          stream: true,
          tools: this.toolRouter.definitions(),
          tool_choice: "auto",
        }),
        tracker,
        messages,
      );
      let finalText = initial.text || "我在呢。你慢慢说，我听着。";
      let usage = initial.usage;
      if (initial.toolCalls.length) {
        const toolMessages = await this.executeToolCalls({
          calls: initial.toolCalls,
          requestId,
          userId: request.user_id,
        });
        toolRecords.push(...toolMessages.records);
        for (const record of toolMessages.records) this.conversationStore?.recordToolCall?.(record);
        const followUpMessages: LLMMessage[] = [
          ...messages,
          { role: "assistant", content: initial.text, tool_calls: initial.toolCalls },
          ...toolMessages.messages,
        ];
        const final = await this.bufferProviderStream(
          this.options.provider.stream({
            ...modelConfig,
            messages: followUpMessages,
            stream: true,
            tool_choice: "none",
          }),
          tracker,
          followUpMessages,
        );
        finalText = final.text || "我在呢。你慢慢说，我听着。";
        usage = final.usage;
      }
      const romance = this.romanceGate.check(finalText, settings);
      const output = this.outputSafety.check(finalText);
      const finalSafety = mergeSafety(inputSafety, romance, output);
      if (finalSafety.rewrite_required && finalSafety.rewritten_text) finalText = finalSafety.rewritten_text;
      const avatar = inferAvatarSignal(finalText);
      yield { event: "avatar_signal", data: avatar };
      for (const delta of splitForStreaming(finalText)) {
        yield { event: "text_delta", data: { delta } };
      }
      const candidates = await this.memoryController.processUserMessage({
        userId: request.user_id,
        message: request.input.text,
        sourceMessageId: userMessageId,
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
        tool_calls: toolRecords.map((record) => record.id),
        first_token_latency: tracker.firstTokenLatencyMs(),
        total_latency: tracker.totalLatencyMs(),
        usage,
        safety_flags: finalSafety.flags,
      });
      if (shouldPersistEmotionalState(emotionalState, previousEmotionalState)) this.conversationStore?.saveEmotionalState?.(request.user_id, emotionalState);
      this.conversationStore?.saveMessage?.({
        id: userMessageId,
        session_id: request.session_id,
        user_id: request.user_id,
        role: "user",
        content: request.input.text,
      });
      this.conversationStore?.saveMessage?.({
        id: messageId,
        session_id: request.session_id,
        user_id: request.user_id,
        role: "assistant",
        content: finalText,
        emotion: avatar.emotion,
        avatar_action: avatar.action,
      });
      yield this.streamMapper.done(messageId, usage, tracker.totalLatencyMs(), tracker.firstTokenLatencyMs());
    } catch (error) {
      yield { event: "error", data: { code: "stream_failed", message: "stream failed" } };
    }
  }

  private relationshipFor(userId: string): RelationshipState {
    return this.conversationStore?.getRelationshipState?.(userId) ?? defaultRelationship();
  }

  private async bufferProviderStream(
    stream: AsyncIterable<LLMStreamChunk>,
    tracker: LatencyTracker,
    messages: LLMMessage[],
  ): Promise<{ text: string; usage: Usage; toolCalls: LLMToolCall[] }> {
    let text = "";
    let usage: Usage = { prompt_tokens: 0, completion_tokens: 0 };
    let toolCalls: LLMToolCall[] = [];
    for await (const chunk of stream) {
      if (chunk.delta) {
        tracker.markFirstToken();
        text += chunk.delta;
      }
      if (chunk.usage) usage = chunk.usage;
      if (chunk.tool_calls?.length) toolCalls = chunk.tool_calls;
    }
    if (usage.prompt_tokens === 0 && usage.completion_tokens === 0) {
      usage = approxUsageFromMessages(JSON.stringify(messages), text);
    }
    return { text, usage, toolCalls };
  }

  private async executeToolCalls(params: {
    calls: LLMToolCall[];
    requestId: string;
    userId: string;
  }): Promise<{ records: ToolCallRecord[]; messages: LLMMessage[] }> {
    const records: ToolCallRecord[] = [];
    const messages: LLMMessage[] = [];
    for (const call of params.calls) {
      const toolName = call.function?.name || "unknown_tool";
      try {
        const args = parseToolArguments(call.function?.arguments ?? "{}");
        const { record, result } = await this.toolRouter.execute({
          request_id: params.requestId,
          user_id: params.userId,
          tool_name: toolName,
          arguments_json: args,
        });
        records.push(record);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: toolName,
          content: JSON.stringify({ allowed: record.allowed, result: result ?? record.result_summary }),
        });
      } catch (error) {
        const record: ToolCallRecord = {
          id: randomId("tool"),
          request_id: params.requestId,
          user_id: params.userId,
          tool_name: toolName,
          arguments_json: {},
          allowed: false,
          result_summary: `tool_failed: ${safeToolError(error)}`,
          created_at: nowIso(),
        };
        records.push(record);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: toolName,
          content: JSON.stringify({ allowed: false, error: "tool_failed" }),
        });
      }
    }
    return { records, messages };
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

function blockedInputText(safety: AgentResponse["safety"]): string {
  if (safety.flags.includes("crisis_self_harm")) {
    return "我先陪你稳住一下。如果你有伤害自己的冲动，请马上联系身边可信的人或当地紧急服务。";
  }
  if (safety.flags.includes("minor_romance_risk")) {
    return "这个恋爱/暧昧模式只适合成年人使用。如果你还未成年，我不能和你发展恋爱关系；但我可以用安全、普通陪伴的方式聊学习、生活和情绪支持。";
  }
  return "我先陪你稳住一下。如果你有伤害自己的冲动，请马上联系身边可信的人或当地紧急服务。";
}

function defaultRelationship(): RelationshipState {
  return { stage: "friendly_romantic", intimacy_level: 2, trust_level: 2 };
}

function splitForStreaming(text: string, chunkSize = 12): string[] {
  const chars = Array.from(text);
  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += chunkSize) {
    chunks.push(chars.slice(i, i + chunkSize).join(""));
  }
  return chunks.length > 0 ? chunks : [""];
}

function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("tool arguments must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function safeToolError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 120);
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

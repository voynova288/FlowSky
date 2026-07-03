export type ChatMode =
  | "girlfriend_chat"
  | "girlfriend_complex"
  | "memory_extraction"
  | "safety_rewrite";

export interface ChatRequest {
  request_id?: string;
  user_id: string;
  session_id: string;
  input: {
    type: "text";
    text: string;
  };
  mode?: ChatMode;
  client_context?: {
    timezone?: string;
    voice_enabled?: boolean;
    avatar_enabled?: boolean;
  };
}

export interface AgentResponse {
  request_id: string;
  message_id: string;
  text: string;
  emotion: string;
  avatar_action: string;
  memory_candidates: MemoryCandidate[];
  tool_calls: ToolCallRecord[];
  safety: SafetyResult;
  usage: Usage;
  latency_ms: number;
}

export type StreamEvent =
  | { event: "text_delta"; data: { delta: string } }
  | { event: "avatar_signal"; data: { emotion: string; action: string } }
  | { event: "memory_candidate"; data: MemoryCandidate }
  | { event: "done"; data: { message_id: string; usage: Usage; first_token_latency_ms?: number; total_latency_ms: number } }
  | { event: "error"; data: { code: string; message: string } };

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface LLMCompleteRequest {
  model: string;
  messages: LLMMessage[];
  stream?: false;
  temperature?: number;
  thinking?: { type: "enabled" | "disabled" };
  reasoning_effort?: "low" | "medium" | "high";
  response_format?: { type: "json_object" };
}

export interface LLMStreamRequest extends Omit<LLMCompleteRequest, "stream"> {
  stream: true;
}

export interface LLMResponse {
  text: string;
  usage: Usage;
  raw?: unknown;
}

export interface LLMStreamChunk {
  delta?: string;
  done?: boolean;
  usage?: Usage;
  raw?: unknown;
}

export interface CharacterCard {
  id: string;
  name: string;
  age_style: "adult";
  personality: string[];
  speaking_style: {
    tone: string;
    sentence_length: string;
    emoji_level: string;
    voice_style: string;
  };
  relationship: RelationshipState;
  boundaries: {
    respect_user_autonomy: boolean;
    do_not_claim_to_be_human: boolean;
    do_not_replace_real_relationships: boolean;
    adult_user_only_for_romance: boolean;
  };
}

export type RelationshipStage =
  | "stranger"
  | "familiar"
  | "close"
  | "friendly_romantic"
  | "romantic_light"
  | "romantic_stable";

export interface RelationshipState {
  stage: RelationshipStage;
  intimacy_level: number;
  trust_level: number;
}

export interface UserSettings {
  memory_enabled: boolean;
  proactive_enabled: boolean;
  romance_realism_level: number;
  voice_enabled: boolean;
  avatar_enabled: boolean;
  preferred_name?: string;
  quiet_hours?: string[];
  adult_romance_enabled?: boolean;
}

export type MemoryType =
  | "session_memory"
  | "profile_memory"
  | "preference_memory"
  | "episodic_memory"
  | "relationship_memory"
  | "sensitive_memory";

export interface MemoryCandidate {
  should_store: boolean;
  memory_type: MemoryType;
  content: string;
  confidence: number;
  sensitivity: "low" | "medium" | "high";
  needs_user_confirmation: boolean;
  source_message_id: string;
}

export interface StoredMemory extends MemoryCandidate {
  id: string;
  user_id: string;
  user_confirmed: boolean;
  created_at: string;
  updated_at: string;
  deleted_at?: string;
}

export interface SafetyResult {
  level: "normal" | "caution" | "blocked";
  flags: string[];
  rewrite_required?: boolean;
  rewritten_text?: string | null;
}

export interface ToolCallRecord {
  id: string;
  request_id: string;
  user_id: string;
  tool_name: string;
  arguments_json: Record<string, unknown>;
  allowed: boolean;
  result_summary?: string;
  created_at: string;
}

import type { LLMStreamChunk, StreamEvent, Usage } from "../types.ts";

export class StreamEventMapper {
  mapTextDelta(chunk: LLMStreamChunk): StreamEvent | null {
    if (!chunk.delta) return null;
    return { event: "text_delta", data: { delta: chunk.delta } };
  }

  avatarSignal(text: string): StreamEvent {
    return {
      event: "avatar_signal",
      data: inferAvatarSignal(text),
    };
  }

  done(messageId: string, usage: Usage, totalLatencyMs: number, firstTokenLatencyMs?: number): StreamEvent {
    return {
      event: "done",
      data: { message_id: messageId, usage, first_token_latency_ms: firstTokenLatencyMs, total_latency_ms: totalLatencyMs },
    };
  }
}

export function inferAvatarSignal(text: string): { emotion: string; action: string } {
  if (/辛苦|累|抱抱|陪你|没关系/.test(text)) return { emotion: "gentle", action: "soft_smile" };
  if (/吃醋|撒娇/.test(text)) return { emotion: "playful", action: "tilt_head" };
  return { emotion: "warm", action: "soft_smile" };
}

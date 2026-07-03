import type { LLMCompleteRequest, LLMResponse, LLMStreamChunk, LLMStreamRequest } from "../types.ts";

export interface LLMProvider {
  complete(request: LLMCompleteRequest): Promise<LLMResponse>;
  stream(request: LLMStreamRequest): AsyncIterable<LLMStreamChunk>;
}

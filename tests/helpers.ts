import type { LLMCompleteRequest, LLMProvider, LLMResponse, LLMStreamChunk, LLMStreamRequest } from "../packages/agent-gateway/src/index.ts";

export class FakeProvider implements LLMProvider {
  lastRequest?: LLMCompleteRequest | LLMStreamRequest;
  private readonly text: string;

  constructor(text = "辛苦啦。我在这里陪你慢慢说。") {
    this.text = text;
  }

  async complete(request: LLMCompleteRequest): Promise<LLMResponse> {
    this.lastRequest = request;
    return {
      text: this.text,
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    };
  }

  async *stream(request: LLMStreamRequest): AsyncIterable<LLMStreamChunk> {
    this.lastRequest = request;
    yield { delta: "辛苦" };
    yield { delta: "啦" };
    yield { usage: { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102 } };
    yield { done: true };
  }
}

// src/applications/pipeline/LLMClient.ts
//
// Abstract token-streaming client for pipeline "llm" node execution.
//
// This library ships the interface only. Concrete implementations
// (Anthropic, Bedrock, OpenAI, mock/fixture, record-replay, etc.)
// live in the consuming project — distributed-core stays infrastructure,
// free of vendor SDK dependencies.
//
// A caller instantiates their chosen client and passes it into
// `PipelineModule` via config. The executor treats every client the
// same way: start a stream, yield token chunks, receive a single
// `done` sentinel with the full response and token counts.
//
// All streams must honour an `AbortSignal` for cancellation.

export type LLMChunk =
  | { done: false; token: string }
  | { done: true; response: string; tokensIn: number; tokensOut: number };

export interface LLMStreamOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LLMClient {
  /**
   * Stream a completion. Yields token chunks; the final chunk has `done: true`
   * with the assembled full response and token counts.
   *
   * Throws if `signal` is already aborted before the stream starts.
   * Stops iterating and throws `AbortError` if `signal` fires mid-stream.
   */
  stream(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    opts?: LLMStreamOptions,
  ): AsyncIterable<LLMChunk>;
}

// ---------------------------------------------------------------------------
// Test / development fixture
// ---------------------------------------------------------------------------

/**
 * Deterministic token-streaming client for tests. Takes an array of
 * pre-scripted responses; the Nth `stream()` call returns the Nth entry
 * as a sequence of single-character tokens followed by a `done` chunk.
 *
 * Respects `AbortSignal` — mid-stream abort throws `AbortError`.
 *
 * Intended for unit and integration tests only. Real integrations should
 * supply their own `LLMClient` implementation.
 */
export class FixtureLLMClient implements LLMClient {
  private callIndex = 0;
  private readonly responses: string[];
  private readonly tokensInPerCall: number[];

  constructor(responses: string[] | string[][], tokensInPerCall: number[] = []) {
    this.responses = (responses as string[]).map(r => (Array.isArray(r) ? r.join('') : r));
    this.tokensInPerCall = tokensInPerCall;
  }

  reset(): void {
    this.callIndex = 0;
  }

  stream(
    _model: string,
    _systemPrompt: string,
    _userPrompt: string,
    opts: LLMStreamOptions = {},
  ): AsyncIterable<LLMChunk> {
    const { signal } = opts;
    const response = this.responses[this.callIndex] ?? '';
    const tokensIn = this.tokensInPerCall[this.callIndex] ?? Math.max(1, Math.round(_userPrompt.length / 4));
    this.callIndex++;

    return {
      [Symbol.asyncIterator]: async function* () {
        if (signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }

        let fullResponse = '';
        for (const char of response) {
          if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }
          fullResponse += char;
          yield { done: false, token: char };
        }

        yield {
          done: true,
          response: fullResponse,
          tokensIn,
          tokensOut: Math.max(1, Math.round(fullResponse.length / 4)),
        };
      },
    };
  }
}

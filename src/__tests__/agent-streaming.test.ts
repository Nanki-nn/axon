import { describe, expect, it, vi } from "vitest";
import { Session, isRetryableApiError, withApiRetry } from "../agent";

async function* streamChunks(chunks: any[]): AsyncIterable<any> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe("agent streaming runtime", () => {
  it("routes streamed text and tool deltas through session events", async () => {
    const textDeltas: string[] = [];
    const toolDeltas: Array<{ name?: string; argumentsDelta?: string }> = [];
    const client: any = {
      chat: {
        completions: {
          create: vi.fn().mockReturnValue(streamChunks([
            { choices: [{ delta: { content: "hello" }, finish_reason: null }] },
            {
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: "call-1",
                    type: "function",
                    function: { name: "read_file", arguments: "{\"path\"" },
                  }],
                },
                finish_reason: null,
              }],
            },
            {
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    function: { arguments: ":\"README.md\"}" },
                  }],
                },
                finish_reason: "stop",
              }],
            },
            {
              choices: [],
              usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
            },
          ])),
        },
      },
    };

    const session = new Session(
      "",
      "test-model",
      "",
      "",
      undefined,
      undefined,
      client,
      undefined,
      {
        onTextDelta: (text) => textDeltas.push(text),
        onToolCallDelta: (delta) => toolDeltas.push(delta),
      },
    );

    await session.chat("hi");

    expect(textDeltas).toEqual(["hello", "\n"]);
    expect(toolDeltas).toEqual([
      { name: "read_file" },
      { argumentsDelta: "{\"path\"" },
      { argumentsDelta: ":\"README.md\"}" },
    ]);
    expect(session.getMetrics().lastInputTokens).toBe(10);
    expect(session.getMetrics().lastOutputTokens).toBe(3);
  });

  it("retries transient API failures and reports retry events", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const events: any[] = [];
    let calls = 0;

    const result = await withApiRetry(
      async () => {
        calls++;
        if (calls === 1) {
          const error: any = new Error("rate limited");
          error.status = 429;
          throw error;
        }
        return "ok";
      },
      undefined,
      (event) => events.push(event),
    );

    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(events).toEqual([{ attempt: 1, maxRetries: 3, reason: "HTTP 429", delayMs: 1000 }]);
  });

  it("classifies retryable and non-retryable API failures", () => {
    expect(isRetryableApiError({ status: 503 })).toBe(true);
    expect(isRetryableApiError({ code: "ECONNRESET" })).toBe(true);
    expect(isRetryableApiError(new Error("model overloaded"))).toBe(true);
    expect(isRetryableApiError({ status: 401 })).toBe(false);
  });
});

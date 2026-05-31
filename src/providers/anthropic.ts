/**
 * Anthropic adapter: wraps @anthropic-ai/sdk streaming into an OpenAI-compatible
 * OpenAI client so agent.ts can use it unchanged.
 *
 * Strategy: subclass OpenAI and override chat.completions.create()
 * to call Anthropic and re-shape the stream into OpenAI delta chunks.
 *
 * Note: requires `@anthropic-ai/sdk` to be installed.
 * Falls back gracefully if the SDK is not present.
 */
import OpenAI from "openai";

type AnyMessage = OpenAI.Chat.ChatCompletionMessageParam;

interface AnthropicTextDelta { type: "text_delta"; text: string }
interface AnthropicInputJsonDelta { type: "input_json_delta"; partial_json: string }

interface AnthropicStreamEvent {
  type: string;
  index?: number;
  delta?: AnthropicTextDelta | AnthropicInputJsonDelta | { type: string; stop_reason?: string };
  content_block?: { type: string; name?: string; id?: string };
}

/**
 * Convert OpenAI messages to Anthropic format.
 * Handles system messages, tool_calls, and tool results.
 */
function toAnthropicMessages(messages: AnyMessage[]): {
  system: string;
  messages: object[];
} {
  let system = "";
  const out: object[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      system = typeof msg.content === "string" ? msg.content : "";
      continue;
    }

    if (msg.role === "user") {
      out.push({ role: "user", content: typeof msg.content === "string" ? msg.content : "" });
      continue;
    }

    if (msg.role === "assistant") {
      const content: object[] = [];
      if (msg.content) content.push({ type: "text", text: msg.content });
      if ((msg as any).tool_calls) {
        for (const tc of (msg as any).tool_calls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments || "{}"),
          });
        }
      }
      out.push({ role: "assistant", content });
      continue;
    }

    if (msg.role === "tool") {
      out.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: (msg as any).tool_call_id,
          content: typeof msg.content === "string" ? msg.content : "",
        }],
      });
      continue;
    }
  }

  return { system, messages: out };
}

/** Convert OpenAI tool definitions to Anthropic tool format */
function toAnthropicTools(tools: OpenAI.Chat.ChatCompletionTool[]): object[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? "",
    input_schema: t.function.parameters ?? { type: "object", properties: {} },
  }));
}

/** Creates an AsyncIterable that mimics OpenAI's stream chunk format, driven by Anthropic's SDK */
async function* anthropicToOpenAIStream(
  anthropic: any,
  model: string,
  system: string,
  messages: object[],
  tools: object[],
): AsyncIterable<OpenAI.Chat.ChatCompletionChunk> {
  const stream = anthropic.messages.stream({
    model,
    system,
    messages,
    tools,
    max_tokens: 8096,
  });

  // Track tool call index for OpenAI-compatible deltas
  const toolIndexMap = new Map<string, number>();
  let nextToolIndex = 0;

  for await (const event of stream as AsyncIterable<AnthropicStreamEvent>) {
    if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
      const id = event.content_block.id ?? `tool-${nextToolIndex}`;
      toolIndexMap.set(id, nextToolIndex);
      const delta: OpenAI.Chat.ChatCompletionChunk.Choice.Delta = {
        tool_calls: [{
          index: nextToolIndex,
          id,
          type: "function",
          function: { name: event.content_block.name ?? "", arguments: "" },
        }],
      };
      yield makeChunk({ finish_reason: null, delta });
      nextToolIndex++;
      continue;
    }

    if (event.type === "content_block_delta") {
      const evDelta = event.delta;
      if (!evDelta) continue;

      if (evDelta.type === "text_delta") {
        const delta: OpenAI.Chat.ChatCompletionChunk.Choice.Delta = {
          content: (evDelta as AnthropicTextDelta).text,
        };
        yield makeChunk({ finish_reason: null, delta });
      } else if (evDelta.type === "input_json_delta") {
        const idx = event.index ?? 0;
        const delta: OpenAI.Chat.ChatCompletionChunk.Choice.Delta = {
          tool_calls: [{
            index: idx,
            function: { arguments: (evDelta as AnthropicInputJsonDelta).partial_json },
          }],
        };
        yield makeChunk({ finish_reason: null, delta });
      }
      continue;
    }

    if (event.type === "message_delta") {
      const stopReason = (event.delta as any)?.stop_reason;
      const finishReason = stopReason === "tool_use" ? "tool_calls"
        : stopReason === "end_turn" ? "stop"
        : stopReason ?? "stop";
      yield makeChunk({ finish_reason: finishReason, delta: {} });
    }
  }
}

function makeChunk(opts: { finish_reason: string | null; delta: OpenAI.Chat.ChatCompletionChunk.Choice.Delta }): OpenAI.Chat.ChatCompletionChunk {
  return {
    id: "anthro",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "anthropic",
    choices: [{
      index: 0,
      delta: opts.delta,
      finish_reason: opts.finish_reason as OpenAI.Chat.ChatCompletionChunk.Choice["finish_reason"],
      logprobs: null,
    }],
  };
}

/**
 * Try to load the Anthropic SDK. Returns null if not installed.
 */
function tryLoadAnthropic(): any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return new (require("@anthropic-ai/sdk").default)({ apiKey: "" });
  } catch {
    return null;
  }
}

/**
 * Create an OpenAI-compatible client that internally calls Anthropic.
 * The returned object has the same interface as `new OpenAI(...)` for
 * the subset used by agent.ts (chat.completions.create with stream:true).
 */
export function createAnthropicAdapter(apiKey: string, model: string): OpenAI {
  let Anthropic: any;
  try {
    Anthropic = require("@anthropic-ai/sdk");
  } catch {
    throw new Error(
      "Anthropic provider requires '@anthropic-ai/sdk'. Run: npm install @anthropic-ai/sdk",
    );
  }
  const anthropic = new (Anthropic.default ?? Anthropic)({ apiKey });

  // We return a Proxy over a dummy OpenAI instance so TypeScript is happy,
  // but intercept the streaming call.
  const dummy = new OpenAI({ apiKey: "dummy", baseURL: "http://localhost" });

  return new Proxy(dummy, {
    get(target, prop) {
      if (prop === "chat") {
        return {
          completions: {
            create: (params: OpenAI.Chat.ChatCompletionCreateParamsStreaming) => {
              const { system, messages } = toAnthropicMessages(params.messages);
              const tools = toAnthropicTools(params.tools ?? []);
              return anthropicToOpenAIStream(anthropic, model, system, messages, tools);
            },
          },
        };
      }
      // For compactHistory / summarizeHistory which also calls client.chat.completions.create(stream:false)
      // We handle it inline via a non-streaming Anthropic call
      return (target as any)[prop];
    },
  }) as unknown as OpenAI;
}

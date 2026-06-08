/**
 * Anthropic 适配器：将 @anthropic-ai/sdk 的流式输出包装成 OpenAI 兼容格式，
 * 让 agent.ts 无需感知底层 API 差异，直接复用相同的对话循环逻辑。
 *
 * 实现策略：
 *   - 用 Proxy 包装一个 dummy OpenAI 实例
 *   - 拦截 chat.completions.create() 调用
 *   - 内部调用 Anthropic SDK，将事件流转换为 OpenAI delta chunk 格式
 *
 * 依赖：需要安装 @anthropic-ai/sdk（非强制依赖，缺失时抛出友好错误）
 */
import OpenAI from "openai";

type AnyMessage = OpenAI.Chat.ChatCompletionMessageParam;

// Anthropic 流事件中的 delta 类型
interface AnthropicTextDelta { type: "text_delta"; text: string }
interface AnthropicInputJsonDelta { type: "input_json_delta"; partial_json: string }

interface AnthropicStreamEvent {
  type: string;
  index?: number;
  delta?: AnthropicTextDelta | AnthropicInputJsonDelta | { type: string; stop_reason?: string };
  content_block?: { type: string; name?: string; id?: string };
}

/**
 * 将 OpenAI 消息格式转换为 Anthropic 消息格式。
 *
 * 主要差异：
 *   - system 消息在 Anthropic 中是独立的顶层字段，不在 messages 数组里
 *   - tool 消息在 Anthropic 中是 user 角色下的 tool_result 内容块
 *   - assistant 的工具调用在 Anthropic 中是 tool_use 内容块
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
      // 将 OpenAI tool_calls 转为 Anthropic tool_use 内容块
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
      // OpenAI 的 role=tool 消息对应 Anthropic 的 user + tool_result 块
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

/**
 * 将 OpenAI function calling 格式的工具定义转换为 Anthropic 工具格式。
 * 主要差异：parameters → input_schema，description 字段位置不同。
 */
function toAnthropicTools(tools: OpenAI.Chat.ChatCompletionTool[]): object[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? "",
    input_schema: t.function.parameters ?? { type: "object", properties: {} },
  }));
}

/**
 * 将 Anthropic 的流式事件转换为 OpenAI delta chunk 格式的 AsyncIterable。
 *
 * 事件映射：
 *   content_block_start (tool_use)  → tool_calls delta（包含工具名和 id）
 *   content_block_delta (text_delta) → content delta
 *   content_block_delta (input_json_delta) → tool_calls arguments delta
 *   message_delta (stop_reason)     → finish_reason chunk
 */
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

  // 维护工具调用的 index 映射（Anthropic 用 id，OpenAI 用数组 index）
  const toolIndexMap = new Map<string, number>();
  let nextToolIndex = 0;

  for await (const event of stream as AsyncIterable<AnthropicStreamEvent>) {
    // 新工具调用开始：映射 id → index，输出工具名
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
        // 普通文字内容
        const delta: OpenAI.Chat.ChatCompletionChunk.Choice.Delta = {
          content: (evDelta as AnthropicTextDelta).text,
        };
        yield makeChunk({ finish_reason: null, delta });
      } else if (evDelta.type === "input_json_delta") {
        // 工具调用参数的增量 JSON 片段
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
      // 将 Anthropic stop_reason 映射到 OpenAI finish_reason
      const stopReason = (event.delta as any)?.stop_reason;
      const finishReason = stopReason === "tool_use" ? "tool_calls"
        : stopReason === "end_turn" ? "stop"
        : stopReason ?? "stop";
      yield makeChunk({ finish_reason: finishReason, delta: {} });
    }
  }
}

/** 构造一个最小的 OpenAI chunk 对象（流式响应的单个分片） */
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
 * 尝试加载 Anthropic SDK，用于检查是否已安装。
 * 不对外暴露，仅供内部测试用。
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
 * 创建一个伪装成 OpenAI 客户端的 Anthropic 适配器。
 * 返回的对象实现了 agent.ts 所需的 chat.completions.create(stream:true) 接口。
 *
 * 使用 Proxy 技术：大多数属性访问透传给 dummy OpenAI 实例，
 * 只拦截 .chat 属性来替换实现。
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

  // dummy 实例让 TypeScript 类型检查通过，但实际调用被 Proxy 拦截
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
      // compactHistory 等函数也调用 client.chat.completions.create(stream:false)
      // 这里透传给 dummy 实例（不涉及实际 API 调用的属性）
      return (target as any)[prop];
    },
  }) as unknown as OpenAI;
}

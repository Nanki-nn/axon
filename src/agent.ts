import OpenAI from "openai";
import chalk from "chalk";
import { DEFINITIONS, dispatch } from "./tools";
import { confirm } from "./tools/bash";
import { getMode } from "./mode";
import {
  snipCompact, microCompact, toolResultBudget,
  compactHistory, reactiveCompact,
  estimateSize, CONTEXT_LIMIT,
} from "./compaction";
import { HookSystem } from "./hooks";

export const DEFAULT_MODEL = "deepseek-chat";

// 注入给 LLM 的基础系统提示，定义助手的角色和行为准则
const BASE_SYSTEM_PROMPT = `\
You are Axon, a concise AI coding assistant running in the terminal.
You have tools to read/write files and run bash commands.
Always read a file before editing it.
Keep responses short and focused — no unnecessary prose.`;

// 工具调用的内部类型：id 是 OpenAI 分配的唯一标识，arguments 是 JSON 字符串
type ToolCall = { id: string; name: string; arguments: string };

/**
 * Session 是一次完整的 Agent 会话。
 * 它维护对话历史（messages[]）、持有 LLM 客户端，并驱动"LLM → 工具 → LLM"的循环。
 */
export class Session {
  private client: OpenAI;
  private model: string;
  /** 完整对话历史，不含 system 消息（system 在每次 API 调用时动态拼入） */
  private messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  private systemPrompt: string;
  private hooks: HookSystem;

  constructor(
    apiKey: string,
    model: string = DEFAULT_MODEL,
    agentsContext: string = "",   // 来自 AGENTS.md 的项目上下文
    memoryContext: string = "",    // 来自 memory.md 的长期记忆
    hooks: HookSystem = new HookSystem(),
    baseURL?: string,
    client?: OpenAI,               // 可直接注入客户端（如 Anthropic 适配器）
  ) {
    // 优先使用传入的 client，回退到用 apiKey 创建默认客户端
    this.client = client ?? new OpenAI({
      apiKey,
      baseURL: baseURL ?? "https://api.deepseek.com",
    });
    this.model = model;
    this.hooks = hooks;

    // 动态拼接系统提示：基础 + 长期记忆 + 项目上下文 + 技能系统说明
    let prompt = BASE_SYSTEM_PROMPT;
    if (memoryContext) {
      prompt += `\n\n## 长期记忆\n${memoryContext}`;
    }
    if (agentsContext) {
      prompt += `\n\n## 项目上下文（来自 AGENTS.md）\n${agentsContext}`;
    }
    prompt += `\n\n## Skill system\nUse \`skill_list\` to browse available skills, then \`skill_read\` to load one before tackling a matching task.`;
    this.systemPrompt = prompt;
  }

  /**
   * 发送一条用户消息，驱动一轮完整的 Agent 循环，直到 LLM 不再调用工具为止。
   */
  async chat(userMessage: string): Promise<void> {
    this.messages.push({ role: "user", content: userMessage });
    await this.runLoop();
    // 本轮结束，触发插件钩子（如记录会话日志）
    await this.hooks.emit("onTurnEnd", { messages: this.messages });
  }

  /** 会话结束时调用，触发 onSessionEnd 钩子（如 Auto-Dream 整合记忆） */
  async end(): Promise<void> {
    await this.hooks.emit("onSessionEnd", { messages: this.messages });
  }

  // ── private ────────────────────────────────────────────────────────────────

  /**
   * 核心 Agent 循环：不断调用 LLM → 执行工具 → 再调用 LLM，
   * 直到 finishReason 不是 "tool_calls" 为止。
   */
  private async runLoop(): Promise<void> {
    let reactiveRetries = 0; // 防止 reactiveCompact 死循环，最多触发 1 次
    while (true) {
      // 每次 API 调用前先跑压缩流水线，控制 context 体积
      await this.hooks.emit("onBeforeCompact", { messages: this.messages });

      // L3 → L1 → L2 顺序很重要：L3 持久化大结果，L1 裁剪条数，L2 替换旧内容
      this.messages = toolResultBudget(this.messages);
      this.messages = snipCompact(this.messages);
      this.messages = microCompact(this.messages);

      // 体积仍超限时触发 L4 LLM 摘要
      if (estimateSize(this.messages) > CONTEXT_LIMIT) {
        console.log(chalk.dim("[auto compact 触发]"));
        this.messages = await compactHistory(this.messages, this.client, this.model);
      }

      let result: Awaited<ReturnType<typeof this.callApi>>;
      try {
        result = await this.callApi();
        reactiveRetries = 0; // 调用成功，重置计数
      } catch (err: any) {
        // API 返回 prompt_too_long 时，尝试紧急压缩后重试一次
        const isOverLimit =
          err?.message?.toLowerCase().includes("prompt_too_long") ||
          err?.message?.toLowerCase().includes("too many tokens");

        if (isOverLimit && reactiveRetries < 1) {
          this.messages = await reactiveCompact(this.messages, this.client, this.model);
          reactiveRetries++;
          continue;
        }
        throw err;
      }

      const { content, toolCalls, finishReason } = result;

      await this.hooks.emit("onAfterLLMResponse", { content, toolCalls });

      // 把 LLM 的回复（含工具调用请求）追加到对话历史
      if (toolCalls.length > 0) {
        this.messages.push({
          role: "assistant",
          content: content || null,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });
      } else {
        this.messages.push({ role: "assistant", content });
      }

      // LLM 不再要求调用工具，循环结束
      if (finishReason !== "tool_calls") break;

      // plan 模式：展示本轮所有工具调用计划，等用户确认后再执行
      if (getMode() === "plan") {
        console.log(chalk.yellow("\n📋 执行计划："));
        toolCalls.forEach((tc, i) => {
          let input: Record<string, unknown> = {};
          try { input = JSON.parse(tc.arguments); } catch { /* ignore */ }
          console.log(chalk.yellow(`  ${i + 1}. ${tc.name}`) + chalk.dim(`(${JSON.stringify(input)})`));
        });

        const ok = await confirm(chalk.yellow("\n确认执行以上操作？"));
        if (!ok) {
          // 用户拒绝，填入取消消息后退出循环
          for (const tc of toolCalls) {
            this.messages.push({ role: "tool", tool_call_id: tc.id, content: "用户取消了执行。" });
          }
          break;
        }
      }

      // 依次执行每个工具调用，将结果追加到对话历史
      for (const tc of toolCalls) {
        console.log(chalk.dim(`  input: ${tc.arguments}`));
        let input: Record<string, string>;
        try {
          input = JSON.parse(tc.arguments);
        } catch {
          input = {};
        }

        await this.hooks.emit("onBeforeToolCall", { name: tc.name, input });
        const output = await dispatch(tc.name, input);
        await this.hooks.emit("onAfterToolCall", { name: tc.name, input, output });

        // 只打印前 500 字符预览，避免刷屏
        const preview = output.length > 500 ? output.slice(0, 500) + "…" : output;
        console.log(chalk.dim(preview));

        this.messages.push({ role: "tool", tool_call_id: tc.id, content: output });
      }
    }
  }

  /**
   * 向 LLM API 发起流式请求，收集完整的文字内容和工具调用信息后返回。
   * 流式输出让用户能实时看到 LLM 的回复，而不是等待完整结果。
   */
  private async callApi(): Promise<{
    content: string;
    toolCalls: ToolCall[];
    finishReason: string;
  }> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: this.systemPrompt },
        ...this.messages,
      ],
      tools: DEFINITIONS as OpenAI.Chat.ChatCompletionTool[],
      stream: true,
    });

    let content = "";
    let finishReason = "stop";
    // 用 index 作为 key 拼接工具调用参数（OpenAI 流式接口按 index 分片传输）
    const toolCallMap: Record<number, ToolCall> = {};

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;

      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta;

      // 文字内容：实时输出到终端
      if (delta.content) {
        process.stdout.write(delta.content);
        content += delta.content;
      }

      // 工具调用：流式拼接 name 和 arguments
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!toolCallMap[tc.index]) {
            // 第一个分片包含工具名，后续分片追加参数
            toolCallMap[tc.index] = { id: tc.id ?? "", name: tc.function?.name ?? "", arguments: "" };
            process.stdout.write(chalk.cyan(`\n⚙ ${tc.function?.name}`));
          }
          if (tc.function?.arguments) {
            toolCallMap[tc.index].arguments += tc.function.arguments;
            process.stdout.write(".");
          }
        }
      }
    }

    process.stdout.write("\n");
    return { content, toolCalls: Object.values(toolCallMap), finishReason };
  }
}

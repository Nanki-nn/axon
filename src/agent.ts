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

export const DEFAULT_MODEL = "deepseek-chat";

// 基础 system prompt，项目上下文会动态拼接在后面
const BASE_SYSTEM_PROMPT = `\
You are Axon, a concise AI coding assistant running in the terminal.
You have tools to read/write files and run bash commands.
Always read a file before editing it.
Keep responses short and focused — no unnecessary prose.`;

type ToolCall = { id: string; name: string; arguments: string };

export class Session {
  private client: OpenAI;
  private model: string;
  private messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  // 最终注入给模型的 system prompt（基础 + 项目上下文）
  private systemPrompt: string;

  constructor(
    apiKey: string,
    model: string = DEFAULT_MODEL,
    agentsContext: string = "",
    skillDescriptions: string = "",
  ) {
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://api.deepseek.com",
    });
    this.model = model;

    let prompt = BASE_SYSTEM_PROMPT;
    if (skillDescriptions) {
      prompt += `\n\n## Skills available\nUse load_skill(<name>) to get full instructions before tackling a matching task.\n${skillDescriptions}`;
    }
    if (agentsContext) {
      prompt += `\n\n## 项目上下文（来自 AGENTS.md）\n${agentsContext}`;
    }
    this.systemPrompt = prompt;
  }

  async chat(userMessage: string): Promise<void> {
    this.messages.push({ role: "user", content: userMessage });
    await this.runLoop();
  }

  // ── private ────────────────────────────────────────────────────────────────

  private async runLoop(): Promise<void> {
    // reactive compact 最多重试一次，防止无限循环
    let reactiveRetries = 0;
    while (true) {
      // ── 压缩流水线（每次调 API 前执行，便宜的先跑）──────────────────────────
      // 顺序固定：L3 budget → L1 snip → L2 micro
      // L3 必须在 L2 前，否则 L2 会先把内容替换成占位符，L3 就没东西可持久化了
      this.messages = toolResultBudget(this.messages);  // L3: 大结果持久化到磁盘
      this.messages = snipCompact(this.messages);        // L1: 裁剪中间消息
      this.messages = microCompact(this.messages);       // L2: 旧工具结果替换占位符

      // L4: 体积还超限则调 LLM 做摘要（有 API 开销，放最后）
      if (estimateSize(this.messages) > CONTEXT_LIMIT) {
        console.log(chalk.dim("[auto compact 触发]"));
        this.messages = await compactHistory(this.messages, this.client, this.model);
      }

      // ── 调用 API ──────────────────────────────────────────────────────────
      let result: Awaited<ReturnType<typeof this.callApi>>;
      try {
        result = await this.callApi();
        reactiveRetries = 0; // 成功后重置重试计数
      } catch (err: any) {
        // prompt_too_long：触发兜底压缩后重试一次
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

      if (toolCalls.length > 0) {
        // Assistant message must include tool_calls when they exist
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

      if (finishReason !== "tool_calls") break;

      // plan 模式：执行前展示本轮所有工具调用，等用户确认
      if (getMode() === "plan") {
        console.log(chalk.yellow("\n📋 执行计划："));
        toolCalls.forEach((tc, i) => {
          let input: Record<string, unknown> = {};
          try { input = JSON.parse(tc.arguments); } catch { /* ignore */ }
          console.log(chalk.yellow(`  ${i + 1}. ${tc.name}`) + chalk.dim(`(${JSON.stringify(input)})`));
        });

        const ok = await confirm(chalk.yellow("\n确认执行以上操作？"));
        if (!ok) {
          // 用户拒绝：把取消信息作为工具结果喂回模型，让模型优雅响应
          for (const tc of toolCalls) {
            this.messages.push({ role: "tool", tool_call_id: tc.id, content: "用户取消了执行。" });
          }
          break;
        }
      }

      // Execute each tool and feed results back
      for (const tc of toolCalls) {
        console.log(chalk.dim(`  input: ${tc.arguments}`));
        let input: Record<string, string>;
        try {
          input = JSON.parse(tc.arguments);
        } catch {
          input = {};
        }
        const output = await dispatch(tc.name, input);
        const preview = output.length > 500 ? output.slice(0, 500) + "…" : output;
        console.log(chalk.dim(preview));

        this.messages.push({ role: "tool", tool_call_id: tc.id, content: output });
      }
    }
  }

  private async callApi(): Promise<{
    content: string;
    toolCalls: ToolCall[];
    finishReason: string;
  }> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      // DeepSeek 用 messages[0] role=system 传系统提示
      messages: [
        { role: "system", content: this.systemPrompt },
        ...this.messages,
      ],
      tools: DEFINITIONS as OpenAI.Chat.ChatCompletionTool[],
      stream: true,
      // system 作为独立字段传入，不放进 messages 数组
      // （DeepSeek 兼容 OpenAI 格式，system 放 messages[0] 也行，这里用参数更清晰）
    });

    let content = "";
    let finishReason = "stop";
    const toolCallMap: Record<number, ToolCall> = {};

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;

      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta;

      if (delta.content) {
        process.stdout.write(delta.content);
        content += delta.content;
      }

      // Tool call chunks arrive incrementally — accumulate by index
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!toolCallMap[tc.index]) {
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

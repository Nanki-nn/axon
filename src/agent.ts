import OpenAI from "openai";
import chalk from "chalk";
import { DEFINITIONS, dispatch } from "./tools";
import { confirm } from "./tools/bash";
import { getMode } from "./mode";

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

  constructor(apiKey: string, model: string = DEFAULT_MODEL, agentsContext: string = "") {
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://api.deepseek.com",
    });
    this.model = model;

    // 如果发现了 AGENTS.md 内容，拼接到 system prompt 末尾
    this.systemPrompt = agentsContext
      ? `${BASE_SYSTEM_PROMPT}\n\n## 项目上下文（来自 AGENTS.md）\n${agentsContext}`
      : BASE_SYSTEM_PROMPT;
  }

  async chat(userMessage: string): Promise<void> {
    this.messages.push({ role: "user", content: userMessage });
    await this.runLoop();
  }

  // ── private ────────────────────────────────────────────────────────────────

  private async runLoop(): Promise<void> {
    while (true) {
      const { content, toolCalls, finishReason } = await this.callApi();

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

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
  private systemPrompt: string;
  private hooks: HookSystem;

  constructor(
    apiKey: string,
    model: string = DEFAULT_MODEL,
    agentsContext: string = "",
    memoryContext: string = "",
    hooks: HookSystem = new HookSystem(),
    baseURL?: string,
    client?: OpenAI,
  ) {
    this.client = client ?? new OpenAI({
      apiKey,
      baseURL: baseURL ?? "https://api.deepseek.com",
    });
    this.model = model;
    this.hooks = hooks;

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

  async chat(userMessage: string): Promise<void> {
    this.messages.push({ role: "user", content: userMessage });
    await this.runLoop();
    await this.hooks.emit("onTurnEnd", { messages: this.messages });
  }

  async end(): Promise<void> {
    await this.hooks.emit("onSessionEnd", { messages: this.messages });
  }

  // ── private ────────────────────────────────────────────────────────────────

  private async runLoop(): Promise<void> {
    let reactiveRetries = 0;
    while (true) {
      await this.hooks.emit("onBeforeCompact", { messages: this.messages });

      this.messages = toolResultBudget(this.messages);
      this.messages = snipCompact(this.messages);
      this.messages = microCompact(this.messages);

      if (estimateSize(this.messages) > CONTEXT_LIMIT) {
        console.log(chalk.dim("[auto compact 触发]"));
        this.messages = await compactHistory(this.messages, this.client, this.model);
      }

      let result: Awaited<ReturnType<typeof this.callApi>>;
      try {
        result = await this.callApi();
        reactiveRetries = 0;
      } catch (err: any) {
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

      if (finishReason !== "tool_calls") break;

      if (getMode() === "plan") {
        console.log(chalk.yellow("\n📋 执行计划："));
        toolCalls.forEach((tc, i) => {
          let input: Record<string, unknown> = {};
          try { input = JSON.parse(tc.arguments); } catch { /* ignore */ }
          console.log(chalk.yellow(`  ${i + 1}. ${tc.name}`) + chalk.dim(`(${JSON.stringify(input)})`));
        });

        const ok = await confirm(chalk.yellow("\n确认执行以上操作？"));
        if (!ok) {
          for (const tc of toolCalls) {
            this.messages.push({ role: "tool", tool_call_id: tc.id, content: "用户取消了执行。" });
          }
          break;
        }
      }

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
      messages: [
        { role: "system", content: this.systemPrompt },
        ...this.messages,
      ],
      tools: DEFINITIONS as OpenAI.Chat.ChatCompletionTool[],
      stream: true,
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

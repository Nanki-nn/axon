import OpenAI from "openai";
import chalk from "chalk";
import { DEFINITIONS, dispatch, setTaskRunner, getDEFINITIONS } from "./tools";
import { confirm } from "./tools/bash";
import { getMode } from "./mode";
import {
  snipCompact, microCompact, toolResultBudget,
  compactHistory, reactiveCompact,
  estimateSize, CONTEXT_LIMIT,
} from "./compaction";
import { HookSystem } from "./hooks";
import { SkillLoader } from "./skills";
import { runSubagent } from "./subagent";

export const DEFAULT_MODEL = "deepseek-chat";

// 注入给 LLM 的基础系统提示，定义助手的角色和行为准则
const BASE_SYSTEM_PROMPT = `\
You are Axon, a concise AI coding assistant running in the terminal.
You have tools to read/write files and run bash commands.
Always read a file before editing it.
Keep responses short and focused — no unnecessary prose.

## Task tracking
For any task with 3 or more steps, use the \`todo\` tool:
- At the start: list all steps as pending
- Before each step: mark it in_progress (only one at a time)
- After each step: mark it completed`;

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
  /** 连续未调用 todo 工具的轮数，达到阈值时注入 reminder */
  private roundsSinceTodo = 0;

  constructor(
    apiKey: string,
    model: string = DEFAULT_MODEL,
    agentsContext: string = "",
    memoryContext: string = "",
    hooks: HookSystem = new HookSystem(),
    baseURL?: string,
    client?: OpenAI,
    skillLoader?: SkillLoader,
  ) {
    this.client = client ?? new OpenAI({
      apiKey,
      baseURL: baseURL ?? "https://api.deepseek.com",
    });
    this.model = model;
    this.hooks = hooks;

    // 注册 task 工具的执行函数（闭包捕获 client/model/definitions）
    setTaskRunner((prompt, description) => {
      console.log(chalk.dim(`  [task] ${description}: ${prompt.slice(0, 80)}`));
      return runSubagent(prompt, this.client, this.model, getDEFINITIONS());
    });

    // 动态拼接系统提示：基础 + 长期记忆 + 项目上下文 + 技能列表
    let prompt = BASE_SYSTEM_PROMPT;
    if (memoryContext) {
      prompt += `\n\n## 长期记忆\n${memoryContext}`;
    }
    if (agentsContext) {
      prompt += `\n\n## 项目上下文（来自 AGENTS.md）\n${agentsContext}`;
    }
    if (skillLoader && skillLoader.size > 0) {
      prompt += `\n\n## Skills\nUse \`skill_read\` to load a skill before tackling a matching task.\n\n${skillLoader.listSkills()}`;
    } else {
      prompt += `\n\n## Skills\nNo skills available.`;
    }
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
   * 
   * 个人理解：
   * 核心就行调用llm,追加消息上下文，看llm是否要调用工具，不调用就退出，要调用的话就执行工具，继续把工具执行结果追加到消息上下文
   * 把上下文继续传给llm，看看下一轮要不要调用工具，如此循环，直到llm不再调用工具为止。 
   * 
   */
  private debugMessages(tag: string): void {
    console.log(chalk.magenta(`\n[debug] ${tag} — messages 共 ${this.messages.length} 条`));
    for (const msg of this.messages) {
      const role = msg.role;
      let preview = "";
      if (role === "assistant" && "tool_calls" in msg && msg.tool_calls) {
        preview = `tool_calls: ${msg.tool_calls.map((tc: any) => {
          const args = tc.function?.arguments ?? "";
          return `${tc.function?.name ?? "(unnamed)"}(${args.slice(0, 80)})`;
        }).join(", ")}`;
      } else if ("content" in msg && typeof msg.content === "string") {
        preview = msg.content.slice(0, 120);
      } else if ("content" in msg && Array.isArray(msg.content)) {
        preview = "[multi-part]";
      }
      console.log(chalk.magenta(`  [${role}] ${preview}`));
    }
  }

  private async runLoop(): Promise<void> {
    let reactiveRetries = 0; // 防止 reactiveCompact 死循环，最多触发 1 次
    while (true) {
      this.debugMessages("runLoop 顶部");

     // ── 1. 多层压缩流水线 ────────────────────────────────────────────────────────────────
  
      // 每次 API 调用前先跑压缩流水线，控制 context 体积
      await this.hooks.emit("onBeforeCompact", { messages: this.messages });

      // L3 → L1 → L2 顺序很重要：L3 持久化大结果，L1 裁剪条数，L2 替换旧内容
      this.messages = toolResultBudget(this.messages); // L3: 压缩工具返回的大结果
      this.messages = snipCompact(this.messages);  // L1: 裁剪消息条数
      this.messages = microCompact(this.messages);    // L2: 替换旧内容为摘要 

      // 体积仍超限时触发 L4 LLM 摘要
      if (estimateSize(this.messages) > CONTEXT_LIMIT) {
        console.log(chalk.dim("[auto compact 触发]"));
        this.messages = await compactHistory(this.messages, this.client, this.model);
      }

      let result: Awaited<ReturnType<typeof this.callApi>>;
      try {

    // ── 2.调用LLM ────────────────────────────────────────────────────────────────
        result = await this.callApi();
        reactiveRetries = 0; // 调用成功，重置计数
      } catch (err: any) {
        // API 返回 prompt_too_long 时，尝试紧急压缩后重试一次
        const isOverLimit =
          err?.message?.toLowerCase().includes("prompt_too_long") ||
          err?.message?.toLowerCase().includes("too many tokens");

        // 检查是否是 token 超限错误(最多重试 1 次，避免无限循环)
        if (isOverLimit && reactiveRetries < 1) {
          // 紧急压缩后重试
          this.messages = await reactiveCompact(this.messages, this.client, this.model);
          reactiveRetries++;
          continue;
        }
        throw err;
      }

      const { content, toolCalls, finishReason } = result;

      await this.hooks.emit("onAfterLLMResponse", { content, toolCalls });
   
      // ── 3.处理LLM响应（追加对话历史） ────────────────────────────────────────────────────────────────

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

      // ── 3.循环终止条件────────────────────────────────────────────────────────────────

      // LLM 不再要求调用工具，循环结束
      if (finishReason !== "tool_calls") break;

      // ── 4.Plan 模式：用户确认────────────────────────────────────────────────────────────────
     
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

       // ── 4. 执行工具 ────────────────────────────────────────────────────────────────

      // 依次执行每个工具调用，收集结果
      let usedTodo = false;
      const toolResults: OpenAI.Chat.ChatCompletionToolMessageParam[] = [];

      for (const tc of toolCalls) {
        console.log(chalk.dim(`  input: ${tc.arguments}`));
        let input: Record<string, unknown>;
        try {
          input = JSON.parse(tc.arguments);
        } catch {
          input = {};
        }

        // 触发钩子（用于日志、监控等）
        await this.hooks.emit("onBeforeToolCall", { name: tc.name, input });
       
        // 执行实际的工具函数
        const output = await dispatch(tc.name, input);
        await this.hooks.emit("onAfterToolCall", { name: tc.name, input, output });

        if (tc.name === "todo") usedTodo = true;

        // 只打印前 500 字符预览，避免刷屏
        const preview = output.length > 500 ? output.slice(0, 500) + "…" : output;
        console.log(chalk.dim(preview));

        toolResults.push({ role: "tool", tool_call_id: tc.id, content: output });
      }

      // 更新 nag 计数
      this.roundsSinceTodo = usedTodo ? 0 : this.roundsSinceTodo + 1;

      // tool results 逐条追加（OpenAI 要求 role:tool 消息）
      for (const r of toolResults) {
        this.messages.push(r);
      }
      // 连续 3 轮未调用 todo 时，额外追加一条 reminder
      if (this.roundsSinceTodo >= 3) {
        this.messages.push({ role: "user", content: "<reminder>Update your todos.</reminder>" });
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

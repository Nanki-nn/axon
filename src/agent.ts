import OpenAI from "openai";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import { DEFINITIONS, dispatch, getDeferredToolSummary, isToolConcurrencySafe, setTaskRunner, getDEFINITIONS } from "./tools";
import { getMode } from "./mode";
import {
  microCompact, compactHistory,
  estimateSize, CONTEXT_LIMIT,
} from "./compaction";
import { getCompletedTasksSummaries } from "./tools/background";
import { getTeammatesSystemPrompt } from "./tools/teams";
import { HookSystem } from "./hooks";
import { SkillLoader } from "./skills";
import { runSubagent } from "./subagent";
import { logger } from "./logger";
import {
  buildMemoryPromptSection,
  formatMemoriesForInjection,
  recallMemories,
  SideQueryFn,
} from "./features/memory";
import { getDebugLogPath } from "./project-paths";

export const DEFAULT_MODEL = "deepseek-chat";

// 注入给 LLM 的基础系统提示，定义助手的角色和行为准则
const BASE_SYSTEM_PROMPT = `\
You are Axon, a concise local AI assistant running in the terminal.
You have tools to read/write files and run bash commands.
Always read a file before editing it.
Keep responses short and focused — no unnecessary prose.

## Task tracking (persistent)
Use \`task_create\` to create tasks, \`task_update\` to update status/dependencies,
\`task_list\` to view all, and \`task_delete\` to remove tasks.
Tasks are persisted to disk and survive conversation compression.
For any task with 3 or more steps:
- At the start: list all steps as pending
- Before each step: mark it in_progress (only one at a time)
- After each step: mark it completed
Use \`blockedBy\` to set up dependencies between tasks (DAG).`;

function buildPermissionPromptSection(): string {
  const mode = getMode();
  const lines = [
    "## 权限与安全",
    `当前权限模式：${mode}`,
    "- 工具调用会经过统一权限检查；被拒绝或被用户取消时，不要重复提交完全相同的工具调用。",
    "- 危险 shell、后台命令、写入新文件和高风险操作可能需要用户确认。",
    "- 已有文件在写入或编辑前必须先读取；如果文件在读取后被外部修改，需要重新读取。",
    "- 不要把 API key、token、私钥等敏感信息写入日志、记忆或普通输出。",
  ];

  if (mode === "plan") {
    lines.push("- Plan 模式是只读模式：只能读取、列举、搜索和规划；不要尝试写文件或执行 shell。");
  } else if (mode === "accept-edits") {
    lines.push("- Accept Edits 模式会自动允许文件编辑，但危险 shell 仍需要确认。");
  } else if (mode === "dont-ask") {
    lines.push("- Dont Ask 模式不会弹出确认；任何需要确认的操作都会被自动拒绝。");
  } else if (mode === "yolo") {
    lines.push("- YOLO 模式会跳过确认，但仍应主动避免不可逆和超出用户请求范围的操作。");
  }

  return lines.join("\n");
}

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
  /** 本会话已注入过的结构化记忆，避免重复刷屏 */
  private alreadySurfacedMemories = new Set<string>();
  /** 本会话累计注入的结构化记忆字节数，避免撑爆上下文 */
  private sessionMemoryBytes = 0;

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
      logger.info("agent", `[task] ${description}: ${prompt.slice(0, 80)}`);
      return runSubagent(prompt, this.client, this.model, getDEFINITIONS());
    });

    // 动态拼接系统提示：基础 + 长期记忆 + 项目上下文 + 技能列表
    let prompt = BASE_SYSTEM_PROMPT;
    prompt += `\n\n${buildPermissionPromptSection()}`;
    if (memoryContext) {
      prompt += `\n\n## 长期记忆\n${memoryContext}`;
    }
    prompt += `\n\n${buildMemoryPromptSection()}`;
    if (agentsContext) {
      prompt += `\n\n## 项目上下文（来自 AGENTS.md）\n${agentsContext}`;
    }
    if (skillLoader && skillLoader.size > 0) {
      prompt += `\n\n## Skills\nUse \`skill_read\` to load a skill before tackling a matching task.\n\n${skillLoader.listSkills()}`;
    } else {
      prompt += `\n\n## Skills\nNo skills available.`;
    }

    const deferredToolSummary = getDeferredToolSummary();
    if (deferredToolSummary) {
      prompt += `\n\n${deferredToolSummary}`;
    }

    // 注入队友信息
    const teammatesPrompt = getTeammatesSystemPrompt();
    if (teammatesPrompt) {
      prompt += teammatesPrompt;
    }

    this.systemPrompt = prompt;
  }

  /**
   * 发送一条用户消息，驱动一轮完整的 Agent 循环，直到 LLM 不再调用工具为止。
   */
  async chat(userMessage: string): Promise<void> {
    this.messages.push({ role: "user", content: userMessage });
    await this.injectRelevantMemories(userMessage);
    await this.runLoop();
    // 本轮结束，触发插件钩子（如记录会话日志）
    await this.hooks.emit("onTurnEnd", { messages: this.messages });
  }

  /** 会话结束时调用，触发 onSessionEnd 钩子（如 Auto-Dream 整合记忆） */
  async end(): Promise<void> {
    await this.hooks.emit("onSessionEnd", { messages: this.messages });
  }

  // ── private ────────────────────────────────────────────────────────────────

  private buildSideQuery(): SideQueryFn {
    return async (system, userMessage) => {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userMessage },
        ],
        max_tokens: 256,
        stream: false,
      });
      return response.choices[0]?.message?.content ?? "";
    };
  }

  private async injectRelevantMemories(userMessage: string): Promise<void> {
    try {
      const memories = await recallMemories(
        userMessage,
        this.buildSideQuery(),
        this.alreadySurfacedMemories,
        this.sessionMemoryBytes,
      );
      if (memories.length === 0) return;

      const injection = formatMemoriesForInjection(memories);
      const last = this.messages[this.messages.length - 1];
      if (last?.role === "user" && typeof last.content === "string") {
        last.content = `${last.content}\n\n${injection}`;
      } else {
        this.messages.push({ role: "user", content: injection });
      }

      for (const memory of memories) {
        this.alreadySurfacedMemories.add(memory.path);
        this.sessionMemoryBytes += Buffer.byteLength(memory.content);
      }
    } catch (err: any) {
      logger.warn("memory", `结构化记忆召回失败: ${err.message}`);
    }
  }

  /**
   * 核心 Agent 循环：不断调用 LLM → 执行工具 → 再调用 LLM，
   * 直到 finishReason 不是 "tool_calls" 为止。
   */
  private debugMessages(tag: string): void {
    const logPath = getDebugLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const lines: string[] = [];
    lines.push(`\n[${new Date().toISOString()}] ${tag} — messages 共 ${this.messages.length} 条`);
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
      lines.push(`  [${role}] ${preview}`);
    }
    fs.appendFileSync(logPath, lines.join("\n") + "\n");
  }

  private async runLoop(): Promise<void> {
    while (true) {
      this.debugMessages("runLoop 顶部");

      // ── 1a. L1: micro_compact（每轮静默，替换早期工具结果为占位符） ──
      await this.hooks.emit("onBeforeCompact", { messages: this.messages });
      this.messages = microCompact(this.messages);

      // ── 1b. L2: auto_compact（体积超限时 LLM 摘要压缩） ──
      if (estimateSize(this.messages) > CONTEXT_LIMIT) {
        logger.info("agent", "auto compact 触发");
        this.messages = await compactHistory(this.messages, this.client, this.model);
      }

      // ── 1c. 检查后台任务完成状态，注入到消息中 ──
      const completedSummaries = getCompletedTasksSummaries();
      if (completedSummaries.length > 0) {
        const bgContent = completedSummaries.join("\n\n");
        console.log(chalk.dim(`[后台任务完成: ${completedSummaries.length} 个]`));
        this.messages.push({ role: "user", content: `<background-results>\n${bgContent}\n</background-results>` });
      }

      let result: Awaited<ReturnType<typeof this.callApi>>;
      try {
        // ── 2. 调用 LLM ──
        result = await this.callApi();
      } catch (err: any) {
        // API 返回 prompt_too_long 时，紧急压缩后重试一次
        const isOverLimit =
          err?.message?.toLowerCase().includes("prompt_too_long") ||
          err?.message?.toLowerCase().includes("too many tokens");

        if (isOverLimit) {
          logger.warn("agent", "token 超限，紧急压缩");
          this.messages = await compactHistory(this.messages, this.client, this.model);
          continue;
        }
        throw err;
      }

      const { content, toolCalls, finishReason } = result;
      await this.hooks.emit("onAfterLLMResponse", { content, toolCalls });

      // ── 3. 处理 LLM 响应（追加对话历史） ──
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

      // ── 4. 执行工具 ──

      // L3: compact 工具（LLM 手动触发 auto_compact）
      const compactCall = toolCalls.find(tc => tc.name === "compact");
      if (compactCall) {
        logger.info("agent", "manual compact 触发");
        this.messages.push({
          role: "tool",
          tool_call_id: compactCall.id,
          content: "压缩完成，继续对话。",
        });
        this.messages = await compactHistory(this.messages, this.client, this.model);
        this.roundsSinceTodo = 0;
        continue;
      }

      // 执行工具调用，纯只读/并发安全批次可以并行执行
      const toolResults: OpenAI.Chat.ChatCompletionToolMessageParam[] = [];
      const parsedToolCalls = toolCalls.map((tc) => {
        let input: Record<string, unknown>;
        try {
          input = JSON.parse(tc.arguments);
        } catch {
          input = {};
        }
        return { ...tc, input };
      });
      const taskToolNames = ["todo", "task_create", "task_update", "task_list", "task_delete"];
      const usedTodo = parsedToolCalls.some((tc) => taskToolNames.includes(tc.name));
      const canRunConcurrently = parsedToolCalls.length > 1 &&
        parsedToolCalls.every((tc) => isToolConcurrencySafe(tc.name, tc.input));

      const runToolCall = async (tc: ToolCall & { input: Record<string, unknown> }) => {
        console.log(chalk.dim(`  input: ${tc.arguments}`));

        await this.hooks.emit("onBeforeToolCall", { name: tc.name, input: tc.input });

        //----工具调用分发器----
        const output = await dispatch(tc.name, tc.input);
        await this.hooks.emit("onAfterToolCall", { name: tc.name, input: tc.input, output });

        const preview = output.length > 500 ? output.slice(0, 500) + "…" : output;
        console.log(chalk.dim(preview));

        return { role: "tool" as const, tool_call_id: tc.id, content: output };
      };

      if (canRunConcurrently) {
        toolResults.push(...await Promise.all(parsedToolCalls.map(runToolCall)));
      } else {
        for (const tc of parsedToolCalls) {
          toolResults.push(await runToolCall(tc));
        }
      }

      // 更新 nag 计数
      this.roundsSinceTodo = usedTodo ? 0 : this.roundsSinceTodo + 1;

      for (const r of toolResults) {
        this.messages.push(r);
      }
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
            toolCallMap[tc.index].arguments += tc.function?.arguments;
            process.stdout.write(".");
          }
        }
      }
    }

    process.stdout.write("\n");
    return { content, toolCalls: Object.values(toolCallMap), finishReason };
  }
}

import OpenAI from "openai";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import { DEFINITIONS, dispatch, getDeferredToolSummary, isToolConcurrencySafe, setTaskRunner, getDEFINITIONS } from "./tools";
import { getMode } from "./mode";
import {
  microCompact, compactHistory,
  estimateSize, LIGHT_LIMIT, HEAVY_LIMIT,
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
You have tools to read/write files, run bash commands, and manage structured memory.
Always read a file before editing it.
Keep responses short and focused — no unnecessary prose.

## 反模式接种

### 不要扩大范围
修 bug 就修 bug，不要顺手重构周围代码、增加注释或"顺带优化"。任务边界由用户的问题定义，你不负责发现和解决"可以改进的地方"。

### 不要防御性编程
不为不可能发生的场景加 try-catch、null 检查或兜底逻辑。如果某个值理论上一定会存在、某个操作理论上一定会成功，就不要为假设的失败写代码。

### 不要过早抽象
一次用法 → 保持内联。两次用法 → 可以观望。三次及以上 → 考虑抽象。
"Three similar lines > premature abstraction."

## 爆炸半径框架

评估每个操作的风险等级，用「可逆性 × 影响范围」判断：

| 等级 | 特征 | 例子 |
|------|------|------|
| 🟢 低风险 | 可逆，仅影响当前上下文 | 读文件、查数据、写分析 |
| 🟡 中风险 | 可逆但影响共享环境 | 创建文件、npm install、git commit |
| 🔴 高风险 | 不可逆或影响大范围 | git push、rm -rf、修改生产配置 |

原则：高风险操作先向用户说明风险和替代方案，等待确认。

## Task tracking (persistent)
Use \`task_create\` to create tasks, \`task_update\` to update status/dependencies,
\`task_list\` to view all, and \`task_delete\` to remove tasks.
Tasks are persisted to disk and survive conversation compression.
For any task with 3 or more steps:
- At the start: list all steps as pending
- Before each step: mark it_in_progress (only one at a time)
- After each step: mark it completed
Use \`blockedBy\` to set up dependencies between tasks (DAG).

## 工具偏好

优先使用专门工具，而非 shell 命令：
- 读文件 → \`read_file\`（不要用 cat）
- 改文件 → \`edit_file\`（不要用 sed）
- 写新文件 → \`write_file\`（不要用 tee/heredoc）
- 搜索代码 → \`search_files\` / \`list_files\`
- 长时间任务 → \`background_run\` + \`check_background\`

## Output Efficiency
- Use past job listings and previous analysis as tone reference.
- One-sentence third-person branding statement per section.
- Lead with numbers and results.
- Short paragraphs, no filler words.
- Bold one key takeaway per section.`;

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

type ContinueReason =
  | "next_turn"
  | "manual_compact_retry"
  | "prompt_too_long_compact_retry"
  | "max_output_tokens_recovery"
  | "background_result_continuation";

interface LoopMetrics {
  apiCalls: number;
  toolRounds: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  lastInputTokens: number;
  lastOutputTokens: number;
  compactRetries: number;
  maxOutputRecoveries: number;
  continueReasons: Record<string, number>;
}

interface ApiResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface RetryEvent {
  attempt: number;
  maxRetries: number;
  reason: string;
  delayMs: number;
}

export interface SessionEvents {
  onTextDelta?: (text: string) => void;
  onToolCallDelta?: (delta: { name?: string; argumentsDelta?: string }) => void;
  onRetry?: (event: RetryEvent) => void;
}

export function isRetryableApiError(error: any): boolean {
  const status = error?.status ?? error?.statusCode;
  if ([429, 503, 529].includes(status)) return true;
  if (["ECONNRESET", "ETIMEDOUT"].includes(error?.code)) return true;
  const message = String(error?.message ?? "").toLowerCase();
  return message.includes("overloaded") || message.includes("temporarily unavailable");
}

function retryReason(error: any): string {
  return error?.status ? `HTTP ${error.status}` : error?.code || error?.message || "network error";
}

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    }
  });
}

export async function withApiRetry<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
  onRetry?: (event: RetryEvent) => void,
  maxRetries = 3,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      if (signal?.aborted || attempt >= maxRetries || !isRetryableApiError(error)) throw error;
      const delayMs = Math.min(1000 * 2 ** attempt, 30_000) + Math.floor(Math.random() * 1000);
      onRetry?.({
        attempt: attempt + 1,
        maxRetries,
        reason: retryReason(error),
        delayMs,
      });
      await sleepWithAbort(delayMs, signal);
    }
  }
}

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
  private abortController: AbortController | null = null;
  private metrics: LoopMetrics = {
    apiCalls: 0,
    toolRounds: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    lastInputTokens: 0,
    lastOutputTokens: 0,
    compactRetries: 0,
    maxOutputRecoveries: 0,
    continueReasons: {},
  };
  /** 本会话已注入过的结构化记忆，避免重复刷屏 */
  private alreadySurfacedMemories = new Set<string>();
  /** 本会话累计注入的结构化记忆字节数，避免撑爆上下文 */
  private sessionMemoryBytes = 0;
  private processing = false;

  constructor(
    apiKey: string,
    model: string = DEFAULT_MODEL,
    agentsContext: string = "",
    memoryContext: string = "",
    hooks: HookSystem = new HookSystem(),
    baseURL?: string,
    client?: OpenAI,
    skillLoader?: SkillLoader,
    private events: SessionEvents = {
      onTextDelta: (text) => process.stdout.write(text),
      onToolCallDelta: (delta) => {
        if (delta.name) process.stdout.write(chalk.cyan(`\n⚙ ${delta.name}`));
        if (delta.argumentsDelta) process.stdout.write(".");
      },
      onRetry: (event) => {
        console.log(chalk.yellow(`\nRetrying API call ${event.attempt}/${event.maxRetries} after ${event.reason}...`));
      },
    },
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
    this.abortController = new AbortController();
    this.processing = true;
    this.messages.push({ role: "user", content: userMessage });
    try {
      await this.injectRelevantMemories(userMessage);
      await this.runQueryLoop();
      // 本轮结束，触发插件钩子（如记录会话日志）
      await this.hooks.emit("onTurnEnd", { messages: this.messages });
    } finally {
      this.abortController = null;
      this.processing = false;
    }
  }

  abort(): void {
    this.abortController?.abort();
  }

  getMetrics(): LoopMetrics {
    return {
      ...this.metrics,
      continueReasons: { ...this.metrics.continueReasons },
    };
  }

  isProcessing(): boolean {
    return this.processing;
  }

  clearHistory(): void {
    this.messages = [];
    this.roundsSinceTodo = 0;
    this.alreadySurfacedMemories.clear();
    this.sessionMemoryBytes = 0;
  }

  async compactNow(): Promise<void> {
    if (this.messages.length === 0) return;
    this.messages = await compactHistory(this.messages, this.client, this.model);
  }

  exportMessages(): OpenAI.Chat.ChatCompletionMessageParam[] {
    return JSON.parse(JSON.stringify(this.messages));
  }

  importMessages(messages: OpenAI.Chat.ChatCompletionMessageParam[]): void {
    this.messages = JSON.parse(JSON.stringify(messages));
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

  private noteContinue(reason: ContinueReason): void {
    this.metrics.continueReasons[reason] = (this.metrics.continueReasons[reason] ?? 0) + 1;
    logger.info("agent", `continue: ${reason}`);
  }

  private updateUsage(usage: ApiResult["usage"]): void {
    if (!usage) return;
    const input = usage.prompt_tokens ?? 0;
    const output = usage.completion_tokens ?? 0;
    this.metrics.lastInputTokens = input;
    this.metrics.lastOutputTokens = output;
    this.metrics.totalInputTokens += input;
    this.metrics.totalOutputTokens += output;
  }

  private shouldRecoverMaxOutput(finishReason: string, toolCalls: ToolCall[], recoveries: number): boolean {
    return finishReason === "length" && toolCalls.length === 0 && recoveries < 3;
  }

  private assertNotAborted(): boolean {
    return this.abortController?.signal.aborted === true;
  }

  private async runQueryLoop(): Promise<void> {
    let maxOutputRecoveriesThisTurn = 0;

    while (true) {
      if (this.assertNotAborted()) {
        logger.info("agent", "aborted before loop iteration");
        break;
      }

      this.debugMessages("runLoop 顶部");

      // ── 1. 双阈值压缩流水线 ──
      //     LIGHT_LIMIT 以下: 不动
      //     LIGHT_LIMIT ~ HEAVY_LIMIT: 仅 microCompact（去掉冗余 tool_result）
      //     HEAVY_LIMIT 以上: + compactHistory（LLM 摘要）
      await this.hooks.emit("onBeforeCompact", { messages: this.messages });
      const size = estimateSize(this.messages);
      if (size > LIGHT_LIMIT) {
        this.messages = microCompact(this.messages);
      }
      if (size > HEAVY_LIMIT) {
        logger.info("agent", `auto compact 触发 (${size} > ${HEAVY_LIMIT})`);
        this.messages = await compactHistory(this.messages, this.client, this.model);
      }

      // ── 1c. 检查后台任务完成状态，注入到消息中 ──
      const completedSummaries = getCompletedTasksSummaries();
      if (completedSummaries.length > 0) {
        this.noteContinue("background_result_continuation");
        const bgContent = completedSummaries.join("\n\n");
        console.log(chalk.dim(`[后台任务完成: ${completedSummaries.length} 个]`));
        this.messages.push({ role: "user", content: `<background-results>\n${bgContent}\n</background-results>` });
      }

      let result: ApiResult;
      try {
        // ── 2. 调用 LLM ──
        result = await this.callApi();
        this.metrics.apiCalls++;
        this.updateUsage(result.usage);
      } catch (err: any) {
        if (this.assertNotAborted()) {
          logger.info("agent", "aborted during API call");
          break;
        }
        // API 返回 prompt_too_long 时，紧急压缩后重试一次
        const isOverLimit =
          err?.message?.toLowerCase().includes("prompt_too_long") ||
          err?.message?.toLowerCase().includes("too many tokens");

        if (isOverLimit) {
          logger.warn("agent", "token 超限，紧急压缩");
          this.metrics.compactRetries++;
          this.noteContinue("prompt_too_long_compact_retry");
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

      if (this.shouldRecoverMaxOutput(finishReason, toolCalls, maxOutputRecoveriesThisTurn)) {
        maxOutputRecoveriesThisTurn++;
        this.metrics.maxOutputRecoveries++;
        this.noteContinue("max_output_tokens_recovery");
        this.messages.push({
          role: "user",
          content: "<continuation-request>Your previous response was cut off by the model output limit. Continue from exactly where you stopped. Do not repeat completed text unless needed for coherence.</continuation-request>",
        });
        continue;
      }

      // LLM 不再要求调用工具，循环结束
      if (finishReason !== "tool_calls") break;
      this.noteContinue("next_turn");
      this.metrics.toolRounds++;

      // ── 4. 执行工具 ──

      // L3: compact 工具（LLM 手动触发 auto_compact）
      const compactCall = toolCalls.find(tc => tc.name === "compact");
      if (compactCall) {
        logger.info("agent", "manual compact 触发");
        this.noteContinue("manual_compact_retry");
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
        if (this.assertNotAborted()) {
          return { role: "tool" as const, tool_call_id: tc.id, content: "Aborted." };
        }

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
          if (this.assertNotAborted()) break;
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
    usage?: ApiResult["usage"];
  }> {
    return withApiRetry(
      () => this.callApiOnce(),
      this.abortController?.signal,
      this.events.onRetry,
    );
  }

  private async callApiOnce(): Promise<{
    content: string;
    toolCalls: ToolCall[];
    finishReason: string;
    usage?: ApiResult["usage"];
  }> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: this.systemPrompt },
        ...this.messages,
      ],
      tools: DEFINITIONS as OpenAI.Chat.ChatCompletionTool[],
      stream: true,
      stream_options: { include_usage: true },
    }, this.abortController ? { signal: this.abortController.signal } : undefined);

    let content = "";
    let finishReason = "stop";
    let usage: ApiResult["usage"] | undefined;
    // 用 index 作为 key 拼接工具调用参数（OpenAI 流式接口按 index 分片传输）
    const toolCallMap: Record<number, ToolCall> = {};

    for await (const chunk of stream) {
      if (this.assertNotAborted()) break;
      if (chunk.usage) {
        usage = chunk.usage;
      }
      const choice = chunk.choices[0];
      if (!choice) continue;

      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta;

      // 文字内容：实时输出到终端
      if (delta.content) {
        this.events.onTextDelta?.(delta.content);
        content += delta.content;
      }

      // 工具调用：流式拼接 name 和 arguments
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!toolCallMap[tc.index]) {
            // 第一个分片包含工具名，后续分片追加参数
            toolCallMap[tc.index] = { id: tc.id ?? "", name: tc.function?.name ?? "", arguments: "" };
            this.events.onToolCallDelta?.({ name: tc.function?.name ?? "" });
          }
          if (tc.function?.arguments) {
            toolCallMap[tc.index].arguments += tc.function?.arguments;
            this.events.onToolCallDelta?.({ argumentsDelta: tc.function.arguments });
          }
        }
      }
    }

    this.events.onTextDelta?.("\n");
    return { content, toolCalls: Object.values(toolCallMap), finishReason, usage };
  }
}

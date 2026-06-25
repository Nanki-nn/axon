import * as fs from "fs";
import * as path from "path";
import OpenAI from "openai";
import { logger } from "./logger";
import { getTranscriptsDir } from "./project-paths";

/**
 * 三层 context 压缩流水线（参考 claude-code s06_context_compact.py）
 *
 * 1. micro_compact：每轮静默执行，把早期非 read_file 的 tool_result 替换为占位符
 * 2. auto_compact：Token 超过阈值时自动触发 LLM 摘要压缩
 * 3. compact 工具：LLM 手动调用 compact 触发 auto_compact
 */

// ── 阈值常量 ──────────────────────────────────────────────────────────────────

/** 保留最近几条工具结果不压缩（micro_compact） */
const KEEP_RECENT_RESULTS = 3;

/**
 * 双阈值压缩水位线（基于 JSON.stringify 字符数）
 *
 * 低于 LIGHT_LIMIT → 不做任何压缩
 * LIGHT_LIMIT ~ HEAVY_LIMIT → 仅 microCompact（snip 早期 tool_result）
 * 高于 HEAVY_LIMIT → 执行 compactHistory（LLM 摘要）
 */
const LIGHT_LIMIT = 40_000;
const HEAVY_LIMIT = 80_000;

// ── 熔断器 ────────────────────────────────────────────────────────────────────

/**
 * 熔断器：compactHistory 连续失败 N 次后停止，避免死循环浪费 token。
 * 每次成功的 compact 会重置计数器。
 */
const MAX_CONSECUTIVE_FAILURES = 3;

// 注意：这个值是模块级状态，一个进程只服务一个会话，所以安全。
let consecutiveCompactFailures = 0;

type Message = OpenAI.Chat.ChatCompletionMessageParam;

// ── 1. micro_compact ─────────────────────────────────────────────────────────

/**
 * 每轮静默执行：把早期非 read_file 的工具结果替换为短占位符，
 * 保留最近 KEEP_RECENT_RESULTS 条完整内容。
 * 工具结果是 context 膨胀的主要来源。
 */
export function microCompact(messages: Message[]): Message[] {
  const toolResults: number[] = [];

  messages.forEach((msg, mi) => {
    if (msg.role === "tool") toolResults.push(mi);
  });

  if (toolResults.length <= KEEP_RECENT_RESULTS) return messages;

  const toCompact = toolResults.slice(0, -KEEP_RECENT_RESULTS);

  return messages.map((msg, mi) => {
    if (msg.role !== "tool") return msg;
    if (!toCompact.includes(mi)) return msg;

    const content = typeof msg.content === "string" ? msg.content : "";
    if (content.length <= 120) return msg; // 太短不值得压缩
    if (content.startsWith("<skill name=")) return msg; // skill 内容不能压缩

    return { ...msg, content: "[早期工具结果已压缩，如需重新获取请再次调用工具]" };
  });
}

// ── 2. auto_compact ──────────────────────────────────────────────────────────

/**
 * 用 LLM 把整段对话历史压缩成一段摘要，替换掉原有 messages。
 * 压缩前会把完整 transcript 保存到磁盘，方便事后审查。
 *
 * 包含熔断器：连续失败 MAX_CONSECUTIVE_FAILURES 次后不再重试，
 * 后续调用直接返回原始 messages。
 */
export async function compactHistory(
  messages: Message[],
  client: OpenAI,
  model: string
): Promise<Message[]> {
  // 熔断检查
  if (consecutiveCompactFailures >= MAX_CONSECUTIVE_FAILURES) {
    logger.warn("compact", `熔断器已触发 (${consecutiveCompactFailures}次连续失败)，跳过压缩`);
    return messages;
  }

  const transcriptPath = writeTranscript(messages);
  logger.info("compact", `transcript 已保存: ${transcriptPath}`);

  try {
    const summary = await summarizeHistory(messages, client, model);
    // 成功后重置熔断器
    consecutiveCompactFailures = 0;
    return [{ role: "user", content: `[对话已压缩]\n\n${summary}` }];
  } catch (err: any) {
    consecutiveCompactFailures++;
    logger.error("compact", `压缩失败 (${consecutiveCompactFailures}/${MAX_CONSECUTIVE_FAILURES}): ${err.message}`);
    if (consecutiveCompactFailures >= MAX_CONSECUTIVE_FAILURES) {
      logger.warn("compact", "熔断器已触发，本会话不再尝试 auto compact");
    }
    // 失败时不截断消息，返回原样
    return messages;
  }
}

/** 调用 LLM 生成对话摘要 */
async function summarizeHistory(
  messages: Message[],
  client: OpenAI,
  model: string
): Promise<string> {
  const conversation = JSON.stringify(messages).slice(0, 80_000);

  const prompt =
    "请将以下 AI 助手对话历史压缩成摘要，以便继续工作。\n" +
    "需要保留：1.当前目标 2.关键发现和决策 3.已读取/修改的文件 4.剩余工作 5.用户约束。\n" +
    "要求简洁但具体。\n\n" +
    conversation;

  const response = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 2000,
    stream: false,
  });

  return response.choices[0]?.message?.content?.trim() ?? "(摘要为空)";
}

/** 把 messages 写入带时间戳的 JSONL 文件 */
function writeTranscript(messages: Message[]): string {
  const transcriptDir = getTranscriptsDir();
  fs.mkdirSync(transcriptDir, { recursive: true });
  const filePath = path.join(transcriptDir, `transcript-${Date.now()}.jsonl`);
  const lines = messages.map((m) => JSON.stringify(m)).join("\n");
  fs.writeFileSync(filePath, lines, "utf-8");
  return filePath;
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

export function estimateSize(messages: Message[]): number {
  return JSON.stringify(messages).length;
}

export { LIGHT_LIMIT, HEAVY_LIMIT };

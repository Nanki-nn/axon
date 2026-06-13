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

/** messages 总大小超过此值触发 auto_compact */
const CONTEXT_LIMIT = 80_000;

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
 */
export async function compactHistory(
  messages: Message[],
  client: OpenAI,
  model: string
): Promise<Message[]> {
  const transcriptPath = writeTranscript(messages);
  logger.info("compact", `transcript 已保存: ${transcriptPath}`);

  const summary = await summarizeHistory(messages, client, model);

  return [{ role: "user", content: `[对话已压缩]\n\n${summary}` }];
}

/** 调用 LLM 生成对话摘要 */
async function summarizeHistory(
  messages: Message[],
  client: OpenAI,
  model: string
): Promise<string> {
  const conversation = JSON.stringify(messages).slice(0, 80_000);

  const prompt =
    "请将以下编程助手对话历史压缩成摘要，以便继续工作。\n" +
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

export { CONTEXT_LIMIT };

import * as fs from "fs";
import * as path from "path";
import OpenAI from "openai";

/**
 * 四层 context 压缩流水线
 *
 * 核心原则：便宜的先跑，贵的后跑
 *
 *   messages[]
 *     ↓
 *   L3 budget → L1 snip → L2 micro → [体积还超限?]
 *                                      ├─ 否 → 直接调 API
 *                                      └─ 是 → L4 LLM 摘要
 *                                              ↓
 *                                          调 API
 *                                    [prompt_too_long?]
 *                                      └─ 是 → reactive 兜底
 */

// ── 阈值常量 ──────────────────────────────────────────────────────────────────

/** 消息条数超过此值触发 L1 snip */
const MAX_MESSAGES = 50;

/** 保留最近几条工具结果不压缩（L2） */
const KEEP_RECENT_RESULTS = 3;

/** 单条工具结果超过此字节数则持久化到磁盘（L3） */
const PERSIST_THRESHOLD = 30_000;

/** 工具结果总大小超过此值触发 L3 */
const BUDGET_MAX_BYTES = 200_000;

/** 整体 messages 字符串长度超过此值触发 L4 LLM 摘要 */
const CONTEXT_LIMIT = 80_000;

/** transcript 和持久化结果的存储目录 */
const TRANSCRIPT_DIR = path.join(process.cwd(), ".transcripts");
const TOOL_RESULTS_DIR = path.join(process.cwd(), ".task_outputs", "tool-results");

type Message = OpenAI.Chat.ChatCompletionMessageParam;

// ── L1: snipCompact ───────────────────────────────────────────────────────────

/**
 * 消息条数超限时，保留头部 3 条 + 尾部若干条，丢弃中间。
 * 头部保留是为了让模型记住最初的任务目标。
 */
export function snipCompact(messages: Message[]): Message[] {
  if (messages.length <= MAX_MESSAGES) return messages;

  const keepHead = 3;
  const keepTail = MAX_MESSAGES - keepHead;

  let tailStart = messages.length - keepTail;

  // 确保 tail 的起点不落在 tool 消息中间——往前找到对应的 assistant tool_calls
  while (tailStart < messages.length && messages[tailStart].role === "tool") {
    tailStart--;
  }
  // tailStart 现在指向 assistant tool_calls 或更早，确保配对完整
  // 但不能回退到 head 保留区里
  tailStart = Math.max(keepHead, tailStart);

  const snipped = tailStart - keepHead;

  return [
    ...messages.slice(0, keepHead),
    ...(snipped > 0 ? [{ role: "user" as const, content: `[已压缩 ${snipped} 条中间消息]` }] : []),
    ...messages.slice(tailStart),
  ];
}

// ── L2: microCompact ──────────────────────────────────────────────────────────

/**
 * 把较早的工具结果替换成占位符，只保留最近 KEEP_RECENT_RESULTS 条完整内容。
 * 工具结果往往是文件内容，是 context 膨胀的主要来源。
 */
export function microCompact(messages: Message[]): Message[] {
  // 收集所有工具结果的位置
  const toolResults: Array<{ msgIdx: number; blockIdx: number }> = [];

  messages.forEach((msg, mi) => {
    if (msg.role !== "tool") return;
    toolResults.push({ msgIdx: mi, blockIdx: 0 });
  });

  if (toolResults.length <= KEEP_RECENT_RESULTS) return messages;

  // 对较早的工具结果做压缩（保留最近 N 条不动）
  const toCompact = toolResults.slice(0, -KEEP_RECENT_RESULTS);
  const result = messages.map((msg, mi) => {
    if (msg.role !== "tool") return msg;
    const shouldCompact = toCompact.some((t) => t.msgIdx === mi);
    if (!shouldCompact) return msg;

    const content = typeof msg.content === "string" ? msg.content : "";
    if (content.length <= 120) return msg; // 太短了不值得压缩
    // Skill content must persist for the entire session — never compact it
    if (content.startsWith("<skill name=")) return msg;

    return { ...msg, content: "[早期工具结果已压缩，如需重新获取请再次调用工具]" };
  });

  return result;
}

// ── L3: toolResultBudget ──────────────────────────────────────────────────────

/**
 * 当最新一批工具结果总大小超过预算，把最大的几条持久化到磁盘，
 * 在 messages 里只保留预览 + 文件路径引用。
 * L3 必须在 L2 之前跑，否则 L2 会先把内容替换掉，L3 就没东西可持久化了。
 */
export function toolResultBudget(messages: Message[]): Message[] {
  // 找最后一批 tool 消息（连续的 role=tool）
  const lastToolMessages: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "tool") {
      lastToolMessages.unshift(i);
    } else if (lastToolMessages.length > 0) {
      break; // 遇到非 tool 消息就停
    }
  }

  if (lastToolMessages.length === 0) return messages;

  // 计算这批工具结果的总大小
  const total = lastToolMessages.reduce((sum, idx) => {
    const content = messages[idx].content;
    return sum + (typeof content === "string" ? content.length : 0);
  }, 0);

  if (total <= BUDGET_MAX_BYTES) return messages;

  // 按内容大小降序排列，优先持久化最大的
  const sorted = [...lastToolMessages].sort((a, b) => {
    const ca = typeof messages[a].content === "string" ? (messages[a].content as string).length : 0;
    const cb = typeof messages[b].content === "string" ? (messages[b].content as string).length : 0;
    return cb - ca;
  });

  const result = [...messages];
  let remaining = total;

  for (const idx of sorted) {
    if (remaining <= BUDGET_MAX_BYTES) break;
    const content = result[idx].content;
    if (typeof content !== "string" || content.length <= PERSIST_THRESHOLD) continue;

    const persistedPath = persistOutput(content);
    const preview = content.slice(0, 2000);
    result[idx] = {
      ...result[idx],
      content: `<持久化输出>\n文件路径: ${persistedPath}\n预览:\n${preview}\n</持久化输出>`,
    };
    remaining -= content.length - result[idx].content!.toString().length;
  }

  return result;
}

/** 把大型输出写到磁盘，返回文件路径 */
function persistOutput(content: string): string {
  fs.mkdirSync(TOOL_RESULTS_DIR, { recursive: true });
  const filename = `tool-result-${Date.now()}.txt`;
  const filePath = path.join(TOOL_RESULTS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content, "utf-8");
  }
  return filePath;
}

// ── L4: compactHistory ────────────────────────────────────────────────────────

/**
 * 用 LLM 把整段对话历史压缩成一段摘要，替换掉原有 messages。
 * 这是最贵的操作（需要一次额外的 API 调用），所以放在最后。
 * 压缩前会把完整 transcript 保存到磁盘，方便事后审查。
 */
export async function compactHistory(
  messages: Message[],
  client: OpenAI,
  model: string
): Promise<Message[]> {
  // 先把完整历史存档
  const transcriptPath = writeTranscript(messages);
  console.log(chalk.dim(`[transcript 已保存: ${transcriptPath}]`));

  const summary = await summarizeHistory(messages, client, model);

  // 压缩后只保留一条摘要消息，让模型从这里继续
  return [{ role: "user", content: `[对话已压缩]\n\n${summary}` }];
}

/** 调用 LLM 生成对话摘要 */
async function summarizeHistory(
  messages: Message[],
  client: OpenAI,
  model: string
): Promise<string> {
  // 截取前 80000 字符，避免摘要请求本身也超限
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
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const filePath = path.join(TRANSCRIPT_DIR, `transcript-${Date.now()}.jsonl`);
  const lines = messages.map((m) => JSON.stringify(m)).join("\n");
  fs.writeFileSync(filePath, lines, "utf-8");
  return filePath;
}

// ── 兜底：reactiveCompact ─────────────────────────────────────────────────────

/**
 * 当 API 返回 prompt_too_long 错误时的紧急压缩。
 * 策略更激进：只保留最近 5 条消息 + 摘要。
 */
export async function reactiveCompact(
  messages: Message[],
  client: OpenAI,
  model: string
): Promise<Message[]> {
  console.log(chalk.red("[reactive compact 触发]"));
  writeTranscript(messages);
  const summary = await summarizeHistory(messages, client, model);
  return [
    { role: "user", content: `[紧急压缩]\n\n${summary}` },
    ...messages.slice(-5),
  ];
}

// ── 估算 messages 体积 ────────────────────────────────────────────────────────

export function estimateSize(messages: Message[]): number {
  return JSON.stringify(messages).length;
}

export { CONTEXT_LIMIT };

// chalk 在这里也需要用，补上 import
import chalk from "chalk";

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import OpenAI from "openai";

// 长期记忆的文件存储路径（~/.axon/memory/）
const MEMORY_DIR = path.join(os.homedir(), ".axon", "memory");
const SESSIONS_DIR = path.join(MEMORY_DIR, "sessions");     // 每日会话日志目录
const MEMORY_FILE = path.join(MEMORY_DIR, "memory.md");     // 整合后的长期记忆
const LOCK_FILE = path.join(MEMORY_DIR, ".dream.lock");     // Dream 进程锁，防并发
const MAX_MEMORY_BYTES = 8 * 1024; // 注入系统提示的上限（8KB），避免撑爆 context

/**
 * 读取整合后的长期记忆文件，注入到系统提示中。
 * 文件不存在时返回空字符串（首次运行或 Dream 尚未执行）。
 */
export function loadMemoryContext(): string {
  try {
    const content = fs.readFileSync(MEMORY_FILE, "utf-8");
    return content.slice(0, MAX_MEMORY_BYTES);
  } catch {
    return "";
  }
}

/**
 * 将本轮会话的简短摘要追加到当天的日志文件。
 * 日志按日期分文件（YYYY-MM-DD.md），每条记录包含 ISO 时间戳。
 */
export function appendSessionLog(summary: string): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const logFile = path.join(SESSIONS_DIR, `${today}.md`);
  const timestamp = new Date().toISOString();
  const entry = `\n## ${timestamp}\n${summary}\n`;
  fs.appendFileSync(logFile, entry, "utf-8");
}

/**
 * 判断是否应该触发一次 Dream 整合。
 * 满足以下任一条件即触发：
 *   - 累计会话数达到 10 次
 *   - 距上次整合已超过 24 小时
 */
export function shouldDream(sessionCount: number, lastDreamAt: Date): boolean {
  const DREAM_AFTER_SESSIONS = 10;
  const DREAM_AFTER_MS = 24 * 60 * 60 * 1000; // 24 小时（毫秒）
  const hoursSinceDream = Date.now() - lastDreamAt.getTime();
  return sessionCount >= DREAM_AFTER_SESSIONS || hoursSinceDream >= DREAM_AFTER_MS;
}

/**
 * Dream 整合：读取所有会话日志，调用 LLM 合并到 memory.md，然后归档日志。
 * 使用文件锁（.dream.lock）防止多个进程同时执行。
 * 整合完成后，已处理的日志移入 sessions/archived/ 子目录。
 */
export async function runDream(client: OpenAI, model: string): Promise<void> {
  // 尝试获取进程锁，已有锁文件则直接退出（避免并发）
  if (fs.existsSync(LOCK_FILE)) return;
  try {
    // wx 标志：文件存在时失败，原子性创建锁文件
    fs.writeFileSync(LOCK_FILE, process.pid.toString(), { flag: "wx" });
  } catch {
    return; // 另一个进程抢先创建了锁
  }

  try {
    // 按文件名（日期）排序，保证时序一致
    const sessionFiles = fs.existsSync(SESSIONS_DIR)
      ? fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".md")).sort()
      : [];

    if (sessionFiles.length === 0) return;

    // 读取所有会话日志，拼成一个大字符串
    const allSessions = sessionFiles
      .map((f) => {
        const content = fs.readFileSync(path.join(SESSIONS_DIR, f), "utf-8");
        return `### ${f}\n${content}`;
      })
      .join("\n\n");

    // 读取已有的长期记忆（如果存在），与新日志一起送给 LLM
    const existingMemory = fs.existsSync(MEMORY_FILE)
      ? fs.readFileSync(MEMORY_FILE, "utf-8")
      : "";

    const prompt =
      "你是一个记忆整合助手。请将以下会话日志和现有长期记忆整合成一份简洁的记忆文档。\n" +
      "保留：用户偏好、常用工作模式、重要项目背景、已完成的关键任务。\n" +
      "格式：Markdown，按主题分组，总字数不超过2000字。\n\n" +
      (existingMemory ? `## 现有记忆\n${existingMemory}\n\n` : "") +
      `## 新会话日志\n${allSessions.slice(0, 60_000)}`; // 截断避免 prompt 超限

    const response = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 2000,
      stream: false,
    });

    const consolidated = response.choices[0]?.message?.content?.trim() ?? "";
    if (consolidated) {
      fs.mkdirSync(MEMORY_DIR, { recursive: true });
      fs.writeFileSync(MEMORY_FILE, consolidated, "utf-8");

      // 将已处理的会话日志移入归档目录，避免下次重复整合
      const archiveDir = path.join(SESSIONS_DIR, "archived");
      fs.mkdirSync(archiveDir, { recursive: true });
      for (const f of sessionFiles) {
        fs.renameSync(path.join(SESSIONS_DIR, f), path.join(archiveDir, f));
      }
    }
  } finally {
    // 无论成功还是失败，都要释放锁
    try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
  }
}

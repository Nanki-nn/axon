import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import OpenAI from "openai";

const MEMORY_DIR = path.join(os.homedir(), ".axon", "memory");
const SESSIONS_DIR = path.join(MEMORY_DIR, "sessions");
const MEMORY_FILE = path.join(MEMORY_DIR, "memory.md");
const LOCK_FILE = path.join(MEMORY_DIR, ".dream.lock");
const MAX_MEMORY_BYTES = 8 * 1024; // 8KB cap for system prompt injection

/** Read the consolidated long-term memory to inject into system prompt */
export function loadMemoryContext(): string {
  try {
    const content = fs.readFileSync(MEMORY_FILE, "utf-8");
    return content.slice(0, MAX_MEMORY_BYTES);
  } catch {
    return "";
  }
}

/** Append a brief session summary to today's session log */
export function appendSessionLog(summary: string): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const logFile = path.join(SESSIONS_DIR, `${today}.md`);
  const timestamp = new Date().toISOString();
  const entry = `\n## ${timestamp}\n${summary}\n`;
  fs.appendFileSync(logFile, entry, "utf-8");
}

/** Check if a Dream consolidation run should be triggered */
export function shouldDream(sessionCount: number, lastDreamAt: Date): boolean {
  const DREAM_AFTER_SESSIONS = 10;
  const DREAM_AFTER_MS = 24 * 60 * 60 * 1000; // 24 hours
  const hoursSinceDream = Date.now() - lastDreamAt.getTime();
  return sessionCount >= DREAM_AFTER_SESSIONS || hoursSinceDream >= DREAM_AFTER_MS;
}

/**
 * Run the Dream consolidation: read all session logs, call LLM to consolidate
 * into memory.md. Uses a lock file to prevent concurrent runs.
 */
export async function runDream(client: OpenAI, model: string): Promise<void> {
  // Acquire lock
  if (fs.existsSync(LOCK_FILE)) return;
  try {
    fs.writeFileSync(LOCK_FILE, process.pid.toString(), { flag: "wx" });
  } catch {
    return; // Another process got the lock
  }

  try {
    const sessionFiles = fs.existsSync(SESSIONS_DIR)
      ? fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".md")).sort()
      : [];

    if (sessionFiles.length === 0) return;

    const allSessions = sessionFiles
      .map((f) => {
        const content = fs.readFileSync(path.join(SESSIONS_DIR, f), "utf-8");
        return `### ${f}\n${content}`;
      })
      .join("\n\n");

    const existingMemory = fs.existsSync(MEMORY_FILE)
      ? fs.readFileSync(MEMORY_FILE, "utf-8")
      : "";

    const prompt =
      "你是一个记忆整合助手。请将以下会话日志和现有长期记忆整合成一份简洁的记忆文档。\n" +
      "保留：用户偏好、常用工作模式、重要项目背景、已完成的关键任务。\n" +
      "格式：Markdown，按主题分组，总字数不超过2000字。\n\n" +
      (existingMemory ? `## 现有记忆\n${existingMemory}\n\n` : "") +
      `## 新会话日志\n${allSessions.slice(0, 60_000)}`;

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

      // Archive processed session files
      const archiveDir = path.join(SESSIONS_DIR, "archived");
      fs.mkdirSync(archiveDir, { recursive: true });
      for (const f of sessionFiles) {
        fs.renameSync(path.join(SESSIONS_DIR, f), path.join(archiveDir, f));
      }
    }
  } finally {
    try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
  }
}

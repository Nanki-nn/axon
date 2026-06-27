import * as fs from "fs";
import * as path from "path";
import OpenAI from "openai";
import { getSessionsDir } from "./project-paths";

type Message = OpenAI.Chat.ChatCompletionMessageParam;

interface SessionRecord {
  ts: string;
  kind: "snapshot";
  messages: Message[];
}

export function createSessionId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function sessionPath(sessionId: string): string {
  return path.join(getSessionsDir(), `${sessionId}.jsonl`);
}

export function appendSessionSnapshot(sessionId: string, messages: Message[]): void {
  const dir = getSessionsDir();
  fs.mkdirSync(dir, { recursive: true });
  const record: SessionRecord = {
    ts: new Date().toISOString(),
    kind: "snapshot",
    messages,
  };
  fs.appendFileSync(sessionPath(sessionId), JSON.stringify(record) + "\n", "utf-8");
}

export function latestSessionId(): string | null {
  const dir = getSessionsDir();
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => ({
      file,
      mtime: fs.statSync(path.join(dir, file)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  return files[0]?.file.replace(/\.jsonl$/, "") ?? null;
}

export function loadSessionMessages(sessionId: string): Message[] {
  const filePath = sessionPath(sessionId);
  if (!fs.existsSync(filePath)) return [];

  const lines = fs.readFileSync(filePath, "utf-8").split("\n");
  let latest: Message[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Partial<SessionRecord>;
      if (record.kind === "snapshot" && Array.isArray(record.messages)) {
        latest = record.messages;
      }
    } catch {
      // Ignore partial/corrupt trailing JSONL lines.
    }
  }
  return latest;
}

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { findTeammate, inboxPath } from "./storage";
import { TeamMessage } from "./types";

function normalizeRecipient(name: string): string {
  return name === "self" ? "leader" : name;
}

function canReceiveMessage(name: string): boolean {
  return name === "leader" || !!findTeammate(name);
}

/**
 * 发送消息给 leader 或一个队友（写入收件箱 JSONL 文件）。
 */
export function sendMessage(from: string, to: string, content: string): string {
  const recipient = normalizeRecipient(to);
  if (!canReceiveMessage(recipient)) {
    return `错误：队友 "${to}" 不存在。使用 partner_list 查看所有队友。`;
  }

  const msg: TeamMessage = {
    from,
    to: recipient,
    content,
    timestamp: new Date().toISOString(),
  };

  try {
    appendFileSync(inboxPath(recipient), JSON.stringify(msg) + "\n", "utf-8");
    return `消息已发送给 ${recipient}`;
  } catch (err: any) {
    return `发送失败: ${err.message}`;
  }
}

/**
 * 读取并清空收件箱中的所有消息。
 */
export function readInbox(name: string): string {
  const filePath = inboxPath(normalizeRecipient(name));
  if (!existsSync(filePath)) return "收件箱为空。";

  try {
    const content = readFileSync(filePath, "utf-8").trim();
    writeFileSync(filePath, "", "utf-8");

    if (!content) return "收件箱为空。";

    const messages = content.split("\n").map((line) => {
      try {
        const msg = JSON.parse(line) as TeamMessage;
        return `[${msg.timestamp}] 来自 ${msg.from}: ${msg.content}`;
      } catch {
        return `[格式错误] ${line}`;
      }
    });

    return messages.join("\n");
  } catch (err: any) {
    return `读取收件箱失败: ${err.message}`;
  }
}

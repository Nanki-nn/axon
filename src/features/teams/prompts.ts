import { loadTeam } from "./storage";

/**
 * 生成队友列表的描述字符串，用于注入到 LLM 的系统提示中。
 */
export function getTeammatesSystemPrompt(): string {
  const team = loadTeam();
  if (team.length === 0) return "";

  const lines = team.map((t) => `- ${t.name}: ${t.instruction}`);
  return `\n\n## 团队成员\n你有以下 AI 队友可以协作。使用 partner_send 发送消息，partner_read_inbox 读取回复。\n${lines.join("\n")}`;
}

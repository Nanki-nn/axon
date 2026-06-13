import { sendMessage, readInbox } from "./messaging";
import { isTeammateRunning, killTeammate, spawnTeammate } from "./process";
import { findTeammate, getConfigFile, loadTeam, removeInbox, saveTeam } from "./storage";
import { TeammateConfig } from "./types";

/**
 * 创建一个新队友（保存配置但不自动启动子进程）。
 * 队友仅在 leader 的 agent loop 中通过 partner_spawn 启动。
 */
function partnerCreate(input: Record<string, any>): string {
  const { name, instruction, model } = input;

  if (!name || !instruction) {
    return "错误：name 和 instruction 为必填项";
  }

  const team = loadTeam();
  if (team.find((t) => t.name === name)) {
    return `错误：队友 "${name}" 已存在`;
  }

  const config: TeammateConfig = {
    name,
    instruction,
    model,
    createdAt: new Date().toISOString(),
  };

  team.push(config);
  saveTeam(team);

  return `队友 "${name}" 已创建。配置已保存到 ${getConfigFile()}。\n使用 partner_list 查看，使用 partner_spawn 启动。`;
}

/**
 * 列出所有已配置的队友。
 */
function partnerList(): string {
  const team = loadTeam();
  if (team.length === 0) return "暂无队友。使用 partner_create 创建。";

  return team
    .map((t, i) => {
      const running = isTeammateRunning(t.name) ? "运行中" : "未启动";
      return `${i + 1}. ${t.name} ${running}\n   ${t.instruction}`;
    })
    .join("\n");
}

/**
 * 移除一个队友（从配置中删除，如果进程运行中则杀掉）。
 */
function partnerRemove(input: Record<string, any>): string {
  const { name } = input;
  const team = loadTeam();
  const idx = team.findIndex((t) => t.name === name);
  if (idx === -1) return `错误：队友 "${name}" 不存在`;

  killTeammate(name);
  team.splice(idx, 1);
  saveTeam(team);
  removeInbox(name);

  return `队友 "${name}" 已移除。`;
}

/**
 * 发送消息给一个队友。
 */
function partnerSend(input: Record<string, any>): string {
  return sendMessage("leader", input.to, input.content);
}

/**
 * 读取 leader 的收件箱。
 */
function partnerReadInbox(): string {
  return readInbox("leader");
}

/**
 * 广播消息给所有队友。
 */
function partnerBroadcast(input: Record<string, any>): string {
  const team = loadTeam();
  if (team.length === 0) return "暂无队友。";

  let sent = 0;
  for (const t of team) {
    sendMessage("leader", t.name, input.content);
    sent++;
  }
  return `消息已广播给 ${sent} 个队友。`;
}

/**
 * 启动一个已配置的队友子进程。
 */
function partnerSpawn(input: Record<string, any>): string {
  const { name } = input;
  const config = findTeammate(name);
  if (!config) return `错误：队友 "${name}" 不存在。先使用 partner_create 创建。`;

  if (isTeammateRunning(name)) {
    return `队友 "${name}" 已在运行中。`;
  }

  const child = spawnTeammate(config);
  if (!child) {
    return `启动 "${name}" 失败：无法确定入口文件。`;
  }

  return `队友 "${name}" 已启动 (PID: ${child.pid})。`;
}

export const teamToolHandlers = {
  partner_create: partnerCreate as (input: Record<string, any>) => string,
  partner_list: partnerList as (input: Record<string, any>) => string,
  partner_remove: partnerRemove as (input: Record<string, any>) => string,
  partner_send: partnerSend as (input: Record<string, any>) => string,
  partner_read_inbox: partnerReadInbox as (input: Record<string, any>) => string,
  partner_broadcast: partnerBroadcast as (input: Record<string, any>) => string,
  partner_spawn: partnerSpawn as (input: Record<string, any>) => string,
};

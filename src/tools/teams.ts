import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { spawn, ChildProcess } from "child_process";

/**
 * 团队协作工具集
 * 提供创建、管理和通信 AI 队友的功能。每个队友作为独立子进程运行，通过文件系统进行消息传递。
 * 设计理念：
 * - 简单的进程隔离：每个队友是一个独立的 Node.js 进程，环境变量区分身份。
 * - 文件系统通信：通过写入和读取 JSONL 格式的收件箱文件进行消息传递，避免复杂的 IPC。
 * - 配置持久化：队友的配置保存在 team.json 中，支持重启后恢复。
 * - LLM 集成：提供系统提示注入函数，让队友信息可用于 LLM 的上下文理解。
 * - 工具函数：提供一套工具函数（partner_create、partner_list、partner_send 等）供 LLM 调用，实现动态管理和通信。
 */


// ── 数据目录 ────────────────────────────────────────────────────────────────

const TEAMS_DIR = join(process.cwd(), ".agents", "teams");
const INBOXES_DIR = join(TEAMS_DIR, "inboxes");
const CONFIG_FILE = join(TEAMS_DIR, "team.json");

function ensureDirs(): void {
  if (!existsSync(INBOXES_DIR)) {
    mkdirSync(INBOXES_DIR, { recursive: true });
  }
}

// ── 类型定义 ────────────────────────────────────────────────────────────────

export interface TeammateConfig {
  name: string;
  instruction: string;
  model?: string;
  /** 队友进程的 PID（仅在 leader 进程中有效） */
  pid?: number | null;
  /** 创建时间 ISO 字符串 */
  createdAt: string;
}

interface Message {
  from: string;
  to: string;
  content: string;
  timestamp: string;
}

// ── 队友管理（持久化到 team.json） ──────────────────────────────────────────

function loadTeam(): TeammateConfig[] {
  try {
    ensureDirs();
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch { /* 静默降级 */ }
  return [];
}

function saveTeam(team: TeammateConfig[]): void {
  try {
    ensureDirs();
    writeFileSync(CONFIG_FILE, JSON.stringify(team, null, 2), "utf-8");
  } catch { /* 静默降级 */ }
}

function findTeammate(name: string): TeammateConfig | undefined {
  return loadTeam().find((t) => t.name === name);
}

// ── 队友子进程管理 ──────────────────────────────────────────────────────────

/** 运行中的队友子进程映射表 */
const teammateProcesses = new Map<string, ChildProcess>();

/**
 * 启动一个队友子进程。
 * 队友运行的是当前 axon CLI，通过环境变量 AXON_TEAMMATE=1 和 AXON_TEAMMATE_NAME 标识身份。
 * 子进程的标准输入/输出与父进程隔离，通过文件收件箱通信。
 */
function spawnTeammate(config: TeammateConfig): ChildProcess | null {
  const entryPoint = process.argv[1];
  if (!entryPoint) return null;

  // 构建队友的指令
  const instructionArg = `你是一个 AI 助手，作为 "${config.name}" 团队成员。你的职责：${config.instruction}`;
  const child = spawn("npx", ["tsx", entryPoint, "--message", instructionArg], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AXON_TEAMMATE: "1",
      AXON_TEAMMATE_NAME: config.name,
    },
  });

  child.stdout?.on("data", (data: Buffer) => {
    console.log(`[队友 ${config.name}] ${data.toString().trim()}`);
  });

  child.stderr?.on("data", (data: Buffer) => {
    console.error(`[队友 ${config.name} stderr] ${data.toString().trim()}`);
  });

  child.on("exit", (code) => {
    console.log(`[队友 ${config.name}] 进程退出，退出码: ${code}`);
    teammateProcesses.delete(config.name);
  });

  child.on("error", (err) => {
    console.error(`[队友 ${config.name}] 启动失败: ${err.message}`);
    teammateProcesses.delete(config.name);
  });

  teammateProcesses.set(config.name, child);
  return child;
}

// ── 消息总线（JSONL 文件收件箱） ────────────────────────────────────────────

function inboxPath(name: string): string {
  ensureDirs();
  return join(INBOXES_DIR, `${name}.jsonl`);
}

/**
 * 发送消息给一个队友（写入收件箱 JSONL 文件）。
 */
function sendMessage(from: string, to: string, content: string): string {
  const team = loadTeam();
  if (!team.find((t) => t.name === to)) {
    return `错误：队友 "${to}" 不存在。使用 partner_list 查看所有队友。`;
  }

  const msg: Message = {
    from,
    to,
    content,
    timestamp: new Date().toISOString(),
  };

  try {
    const filePath = inboxPath(to);
    appendFileSync(filePath, JSON.stringify(msg) + "\n", "utf-8");
    return `消息已发送给 ${to}`;
  } catch (err: any) {
    return `发送失败: ${err.message}`;
  }
}

/**
 * 读取并清空收件箱中的所有消息。
 */
function readInbox(name: string): string {
  const filePath = inboxPath(name);
  if (!existsSync(filePath)) return "收件箱为空。";

  try {
    const content = readFileSync(filePath, "utf-8").trim();
    // 清空文件
    writeFileSync(filePath, "", "utf-8");

    if (!content) return "收件箱为空。";

    const messages = content.split("\n").map((line) => {
      try {
        const msg: Message = JSON.parse(line);
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

// ── LLM 系统提示注入 ────────────────────────────────────────────────────────

/**
 * 生成队友列表的描述字符串，用于注入到 LLM 的系统提示中。
 */
export function getTeammatesSystemPrompt(): string {
  const team = loadTeam();
  if (team.length === 0) return "";

  const lines = team.map((t) => `- ${t.name}: ${t.instruction}`);
  return `\n\n## 团队成员\n你有以下 AI 队友可以协作。使用 partner_send 发送消息，partner_read_inbox 读取回复。\n${lines.join("\n")}`;
}

// ── 工具实现 ────────────────────────────────────────────────────────────────

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

  return `队友 "${name}" 已创建。配置已保存到 ${CONFIG_FILE}。\n使用 partner_list 查看，使用 partner_spawn 启动。`;
}

/**
 * 列出所有已配置的队友。
 */
function partnerList(): string {
  const team = loadTeam();
  if (team.length === 0) return "暂无队友。使用 partner_create 创建。";

  return team
    .map((t, i) => {
      const running = teammateProcesses.has(t.name) ? "🟢 运行中" : "⚪ 未启动";
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

  // 杀掉子进程
  const proc = teammateProcesses.get(name);
  if (proc) {
    proc.kill();
    teammateProcesses.delete(name);
  }

  team.splice(idx, 1);
  saveTeam(team);

  return `队友 "${name}" 已移除。`;
}

/**
 * 发送消息给一个队友。
 */
function partnerSend(input: Record<string, any>): string {
  return sendMessage("leader", input.to, input.content);
}

/**
 * 读取自己的收件箱（作为队友时用）或 leader 的收件箱。
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

  if (teammateProcesses.has(name)) {
    return `队友 "${name}" 已在运行中。`;
  }

  const child = spawnTeammate(config);
  if (!child) {
    return `启动 "${name}" 失败：无法确定入口文件。`;
  }

  return `队友 "${name}" 已启动 (PID: ${child.pid})。`;
}

// ── 工具定义 ────────────────────────────────────────────────────────────────

export const PARTNER_CREATE_DEFINITION = {
  type: "function" as const,
  function: {
    name: "partner_create",
    description: "创建一个新的 AI 队友。保存配置但不启动进程。使用 partner_spawn 启动。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "队友唯一标识名" },
        instruction: { type: "string", description: "队友的角色描述和职责说明" },
        model: { type: "string", description: "队友使用的模型（可选，默认同 leader）" },
      },
      required: ["name", "instruction"],
    },
  },
};

export const PARTNER_LIST_DEFINITION = {
  type: "function" as const,
  function: {
    name: "partner_list",
    description: "列出所有已配置的 AI 队友及运行状态。",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
};

export const PARTNER_REMOVE_DEFINITION = {
  type: "function" as const,
  function: {
    name: "partner_remove",
    description: "移除一个 AI 队友（从配置中删除并杀掉进程）。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "队友名称" },
      },
      required: ["name"],
    },
  },
};

export const PARTNER_SEND_DEFINITION = {
  type: "function" as const,
  function: {
    name: "partner_send",
    description: "发送消息给一个 AI 队友。队友下次读取收件箱时会看到。",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "目标队友名称" },
        content: { type: "string", description: "消息内容" },
      },
      required: ["to", "content"],
    },
  },
};

export const PARTNER_READ_INBOX_DEFINITION = {
  type: "function" as const,
  function: {
    name: "partner_read_inbox",
    description: "读取收件箱中来自队友的所有消息。读取后自动清空。",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
};

export const PARTNER_BROADCAST_DEFINITION = {
  type: "function" as const,
  function: {
    name: "partner_broadcast",
    description: "广播消息给所有 AI 队友。",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "要广播的消息" },
      },
      required: ["content"],
    },
  },
};

export const PARTNER_SPAWN_DEFINITION = {
  type: "function" as const,
  function: {
    name: "partner_spawn",
    description: "启动一个已配置的 AI 队友的子进程。队友会作为独立进程运行。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "队友名称" },
      },
      required: ["name"],
    },
  },
};

// ── 工具处理函数注册表 ──────────────────────────────────────────────────────

export const teamToolHandlers = {
  partner_create:    partnerCreate as (input: Record<string, any>) => string,
  partner_list:      partnerList as (input: Record<string, any>) => string,
  partner_remove:    partnerRemove as (input: Record<string, any>) => string,
  partner_send:      partnerSend as (input: Record<string, any>) => string,
  partner_read_inbox: partnerReadInbox as (input: Record<string, any>) => string,
  partner_broadcast: partnerBroadcast as (input: Record<string, any>) => string,
  partner_spawn:     partnerSpawn as (input: Record<string, any>) => string,
};

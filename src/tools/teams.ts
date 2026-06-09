import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync } from "fs";
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

// ── 消息类型枚举 ────────────────────────────────────────────────────────────

/** 有效消息类型列表 */
export const VALID_MSG_TYPES = [
  "message",           // 普通消息
  "shutdown_request",  // leader 请求队友关闭
  "shutdown_response", // 队友确认关闭
  "plan_submit",       // 队友提交计划待审批
  "plan_approve",      // leader 批准计划
  "plan_reject",       // leader 拒绝计划
  "task_request",      // 队友请求新任务
  "status_update",     // 状态更新
] as const;

export type MsgType = (typeof VALID_MSG_TYPES)[number];

export interface Message {
  from: string;
  to: string;
  type: MsgType;
  content: string;
  /** 用于协议配对（shutdown_request↔response，plan_submit↔approve/reject） */
  request_id?: string;
  timestamp: string;
}

// ── 队友配置 ────────────────────────────────────────────────────────────────

interface TeammateConfig {
  name: string;
  instruction: string;
  model?: string;
  /** 队友进程的 PID（仅在 leader 进程中有效） */
  pid?: number | null;
  /** 创建时间 ISO 字符串 */
  createdAt: string;
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

function spawnTeammate(config: TeammateConfig): ChildProcess | null {
  const entryPoint = process.argv[1];
  if (!entryPoint) return null;

  // 判断运行环境：生产（编译后 node dist/） vs 开发（tsx）
  const isProd = entryPoint.includes("dist/");
  const command = isProd ? "node" : "npx";
  const args = isProd
    ? [entryPoint, "--teammate", config.name]
    : ["tsx", entryPoint, "--teammate", config.name];

  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AXON_TEAMMATE: "1",
      AXON_TEAMMATE_NAME: config.name,
      AXON_TEAMMATE_INSTRUCTION: config.instruction,
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
 * type 指明消息类型（默认 "message"），request_id 用于协议配对。
 */
export function sendMessage(
  from: string,
  to: string,
  content: string,
  type: MsgType = "message",
  request_id?: string,
): string {
  if (to !== "leader" && to !== "self") {
    const team = loadTeam();
    if (!team.find((t) => t.name === to)) {
      return `错误：队友 "${to}" 不存在。使用 partner_list 查看所有队友。`;
    }
  }

  // "self" 映射到发送者自己（leader 发给自己，则写入 leader 收件箱）
  const target = to === "self" ? from : to;

  const msg: Message = {
    from,
    to,
    type,
    content,
    timestamp: new Date().toISOString(),
  };
  if (request_id) msg.request_id = request_id;

  try {
    const filePath = inboxPath(target);
    appendFileSync(filePath, JSON.stringify(msg) + "\n", "utf-8");
    return `消息已发送给 ${to}`;
  } catch (err: any) {
    return `发送失败: ${err.message}`;
  }
}

/**
 * 读取并清空收件箱中的所有消息。
 */
export function readInbox(name: string): string {
  const filePath = inboxPath(name);
  if (!existsSync(filePath)) return "收件箱为空。";

  try {
    const content = readFileSync(filePath, "utf-8").trim();
    writeFileSync(filePath, "", "utf-8");

    if (!content) return "收件箱为空。";

    const messages = content.split("\n").map((line) => {
      try {
        const msg: Message = JSON.parse(line);
        const typeTag = msg.type && msg.type !== "message" ? ` [${msg.type}]` : "";
        const ridTag = msg.request_id ? ` (request_id: ${msg.request_id})` : "";
        return `[${msg.timestamp}] 来自 ${msg.from}${typeTag}${ridTag}: ${msg.content}`;
      } catch {
        return `[格式错误] ${line}`;
      }
    });

    return messages.join("\n");
  } catch (err: any) {
    return `读取收件箱失败: ${err.message}`;
  }
}

// ── 获取收件箱未读消息数 ──────────────────────────────────────────────────

/**
 * 获取某个队友的收件箱未读消息数。
 */
function inboxUnreadCount(name: string): number {
  const filePath = inboxPath(name);
  if (!existsSync(filePath)) return 0;
  try {
    const content = readFileSync(filePath, "utf-8").trim();
    if (!content) return 0;
    return content.split("\n").length;
  } catch {
    return 0;
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

function partnerList(): string {
  const team = loadTeam();
  if (team.length === 0) return "暂无队友。使用 partner_create 创建。";

  return team
    .map((t, i) => {
      const running = teammateProcesses.has(t.name) ? "🟢 运行中" : "⚪ 未启动";
      const unread = inboxUnreadCount(t.name);
      const unreadTag = unread > 0 ? ` (${unread} 条未读)` : "";
      return `${i + 1}. ${t.name} ${running}${unreadTag}\n   ${t.instruction}`;
    })
    .join("\n");
}

function partnerRemove(input: Record<string, any>): string {
  const { name } = input;
  const team = loadTeam();
  const idx = team.findIndex((t) => t.name === name);
  if (idx === -1) return `错误：队友 "${name}" 不存在`;

  const proc = teammateProcesses.get(name);
  if (proc) {
    proc.kill();
    teammateProcesses.delete(name);
  }

  team.splice(idx, 1);
  saveTeam(team);

  // 删除收件箱
  const inboxFile = inboxPath(name);
  if (existsSync(inboxFile)) {
    try { unlinkSync(inboxFile); } catch { /* ignore */ }
  }

  return `队友 "${name}" 已移除。`;
}

function getSenderName(): string {
  return process.env.AXON_TEAMMATE === "1" && process.env.AXON_TEAMMATE_NAME
    ? process.env.AXON_TEAMMATE_NAME
    : "leader";
}

function partnerSend(input: Record<string, any>): string {
  const to = input.to;
  const content = input.content;
  const type: MsgType = input.type || "message";
  const request_id = input.request_id;

  if (!VALID_MSG_TYPES.includes(type)) {
    return `错误：无效的消息类型 "${type}"。有效类型: ${VALID_MSG_TYPES.join(", ")}`;
  }

  const from = getSenderName();
  return sendMessage(from, to, content, type, request_id);
}

function partnerReadInbox(): string {
  const name = getSenderName();
  return readInbox(name);
}

function partnerBroadcast(input: Record<string, any>): string {
  const team = loadTeam();
  if (team.length === 0) return "暂无队友。";

  const content = input.content;
  const type: MsgType = input.type || "message";
  const request_id = input.request_id;

  if (!VALID_MSG_TYPES.includes(type)) {
    return `错误：无效的消息类型 "${type}"。有效类型: ${VALID_MSG_TYPES.join(", ")}`;
  }

  let sent = 0;
  for (const t of team) {
    sendMessage("leader", t.name, content, type, request_id);
    sent++;
  }
  return `消息已广播给 ${sent} 个队友。`;
}

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

// ── 协议辅助函数（供队友进程使用） ────────────────────────────────────────

/**
 * 发送 shutdown_response 给 leader（队友确认关闭时调用）。
 */
export function sendShutdownResponse(name: string, requestId: string): string {
  return sendMessage(name, "leader", "确认关闭", "shutdown_response", requestId);
}

/**
 * 发送 plan_submit 给 leader（队友提交计划待审批时调用）。
 */
export function submitPlan(name: string, content: string, requestId: string): string {
  return sendMessage(name, "leader", content, "plan_submit", requestId);
}

/**
 * 发送 task_request 给 leader（队友请求新任务时调用）。
 */
export function requestTask(name: string, content: string): string {
  return sendMessage(name, "leader", content, "task_request");
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
    description: "列出所有已配置的 AI 队友及运行状态，包括收件箱未读消息数。",
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
    description: "发送消息给一个 AI 队友。支持协议消息类型（shutdown_request/plan_approve 等），协议消息需配合 request_id。",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "目标队友名称" },
        content: { type: "string", description: "消息内容" },
        type: {
          type: "string",
          enum: VALID_MSG_TYPES,
          description: "消息类型，默认 message",
        },
        request_id: {
          type: "string",
          description: "协议请求 ID，用于配对请求和响应（如 shutdown_request↔shutdown_response）",
        },
      },
      required: ["to", "content"],
    },
  },
};

export const PARTNER_READ_INBOX_DEFINITION = {
  type: "function" as const,
  function: {
    name: "partner_read_inbox",
    description: "读取收件箱中来自队友的所有消息。读取后自动清空。会显示消息类型和协议 ID。",
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
    description: "广播消息给所有 AI 队友。支持协议消息类型。",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "要广播的消息" },
        type: {
          type: "string",
          enum: VALID_MSG_TYPES,
          description: "消息类型，默认 message",
        },
        request_id: {
          type: "string",
          description: "协议请求 ID",
        },
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

import { spawn, ChildProcess } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ── 持久化路径 ──────────────────────────────────────────────────────────────

const DATA_DIR = join(homedir(), ".axon");
const DATA_FILE = join(DATA_DIR, "background-tasks.json");

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

// ── 类型定义 ────────────────────────────────────────────────────────────────

export type BackgroundTaskStatus = "running" | "completed" | "failed";

export interface BackgroundTask {
  command: string;
  status: BackgroundTaskStatus;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  startedAt: string; // ISO string，持久化友好
  finishedAt?: string;
  _reported?: boolean;
}

// ── 全局状态 ────────────────────────────────────────────────────────────────

let taskCounter = 0;

/** 从硬盘加载任务记录 */
function loadTasks(): Map<string, BackgroundTask> {
  try {
    ensureDataDir();
    if (existsSync(DATA_FILE)) {
      const raw = readFileSync(DATA_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      const map = new Map<string, BackgroundTask>(Object.entries(parsed));
      // 恢复计数器
      Array.from(map.keys()).forEach((key) => {
        const num = parseInt(key.replace("bg_", ""), 10);
        if (num > taskCounter) taskCounter = num;
      });
      return map;
    }
  } catch (e) {
    // 文件损坏等，静默降级
  }
  return new Map();
}

/** 将任务记录写回硬盘 */
function saveTasks(tasks: Map<string, BackgroundTask>): void {
  try {
    ensureDataDir();
    const obj: Record<string, BackgroundTask> = {};
    for (const [key, val] of tasks) {
      obj[key] = val;
    }
    writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2), "utf-8");
  } catch (e) {
    // 写盘失败不阻断主流程
  }
}

// ── 核心函数 ────────────────────────────────────────────────────────────────

/**
 * 在后台启动一个 shell 命令，返回 taskId。
 * 命令的输出会累积到 stdout/stderr 中，可通过 check_background 查询。
 * 任务记录持久化到 ~/.axon/background-tasks.json。
 */
export function backgroundRun(command: string): string {
  const tasks = loadTasks();
  const taskId = `bg_${++taskCounter}`;

  const task: BackgroundTask = {
    command,
    status: "running",
    stdout: "",
    stderr: "",
    exitCode: null,
    startedAt: new Date().toISOString(),
  };
  tasks.set(taskId, task);
  saveTasks(tasks);

  // 在后台 spawn 执行
  const child = spawn("bash", ["-c", command], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (data: Buffer) => {
    task.stdout += data.toString();
  });

  child.stderr.on("data", (data: Buffer) => {
    task.stderr += data.toString();
  });

  const onFinish = () => {
    saveTasks(loadTasks().set(taskId, task));
  };

  child.on("close", (code: number | null) => {
    task.status = code === 0 ? "completed" : "failed";
    task.exitCode = code;
    task.finishedAt = new Date().toISOString();
    onFinish();
  });

  child.on("error", (err: Error) => {
    task.status = "failed";
    task.exitCode = -1;
    task.stderr += err.message;
    task.finishedAt = new Date().toISOString();
    onFinish();
  });

  return taskId;
}

/**
 * 查询指定后台任务的状态和输出。
 * 任务完成时会返回完整 stdout/stdout，未完成时只返回状态信息。
 */
export function checkBackground(taskId: string): string {
  const tasks = loadTasks();
  const task = tasks.get(taskId);
  if (!task) {
    return JSON.stringify({ error: `任务 ${taskId} 不存在` });
  }

  const MAX_OUTPUT = 50000; // 输出截断上限
  const MAX_PREVIEW = 500;  // 未完成时 stdout 预览长度

  const result: Record<string, any> = {
    taskId,
    status: task.status,
    command: task.command,
    startedAt: task.startedAt,
    exitCode: task.exitCode,
  };

  if (task.status === "running") {
    result.stdout = task.stdout.slice(-MAX_PREVIEW);
    result.stderr = task.stderr.slice(-MAX_PREVIEW);
  } else {
    result.stdout =
      task.stdout.length > MAX_OUTPUT
        ? `[输出过长，仅展示末尾 ${MAX_OUTPUT} 字符]\n` + task.stdout.slice(-MAX_OUTPUT)
        : task.stdout;
    result.stderr =
      task.stderr.length > MAX_OUTPUT
        ? `[输出过长，仅展示末尾 ${MAX_OUTPUT} 字符]\n` + task.stderr.slice(-MAX_OUTPUT)
        : task.stderr;
    result.finishedAt = task.finishedAt;
  }

  return JSON.stringify(result, null, 2);
}

/**
 * 获取所有已完成（非 running）的任务及其摘要。
 * 用于 agent loop 在每次 LLM call 前注入结果。
 */
export function getCompletedTasksSummaries(): string[] {
  const tasks = loadTasks();
  const summaries: string[] = [];
  let changed = false;
  for (const [id, task] of tasks) {
    if (task.status === "running") continue;
    if (task.status === "completed" && !task._reported) {
      task._reported = true;
      changed = true;
      const preview = task.stdout.slice(0, 500);
      summaries.push(
        `【后台任务完成】ID: ${id}\n命令: ${task.command}\n输出: ${preview}`,
      );
    } else if (task.status === "failed" && !task._reported) {
      task._reported = true;
      changed = true;
      const preview = task.stderr.slice(0, 500);
      summaries.push(
        `【后台任务失败】ID: ${id}\n命令: ${task.command}\n错误: ${preview}`,
      );
    }
  }
  if (changed) saveTasks(tasks);
  return summaries;
}

/** 清除所有已完成的后台任务记录 */
export function clearCompletedTasks(): void {
  const tasks = loadTasks();
  for (const [id, task] of tasks) {
    if (task.status !== "running") tasks.delete(id);
  }
  saveTasks(tasks);
}

// ── 工具定义 ────────────────────────────────────────────────────────────────

export const BACKGROUND_RUN_DEFINITION = {
  type: "function" as const,
  function: {
    name: "background_run",
    description:
      "在后台异步执行一个 shell 命令，立即返回任务 ID。适合长时间运行的任务（如 git clone、npm install、大规模编译等），" +
      "不会阻塞当前对话。后续用 check_background 查询状态和输出。",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "要执行的 shell 命令",
        },
      },
      required: ["command"],
    },
  },
};

export const CHECK_BACKGROUND_DEFINITION = {
  type: "function" as const,
  function: {
    name: "check_background",
    description:
      "查询一个后台任务（由 background_run 启动）的状态和输出。返回 JSON，包含 status(running/completed/failed)、stdout、stderr 等。",
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "background_run 返回的任务 ID",
        },
      },
      required: ["taskId"],
    },
  },
};



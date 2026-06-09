import { spawn, ChildProcess } from "child_process";

/**
 * 后台任务工具：background_run 和 check_background
 * 有些命令要跑好几分钟，npm install、git clone、编译等，这时候就不适合在 agent loop 里直接执行了。
 * background_run 启动一个后台任务，立即返回一个 taskId。agent loop 继续执行后续步骤。
 * LLM 可以通过 check_background 查询这个 taskId 的状态和输出，知道它什么时候完成了，结果是什么。
 * agent loop 在每次调用 LLM 前也会自动注入所有已完成任务的摘要，LLM 可以据此调整后续计划。
 */


// ── 类型定义 ────────────────────────────────────────────────────────────────

export type BackgroundTaskStatus = "running" | "completed" | "failed";

export interface BackgroundTask {
  command: string;
  status: BackgroundTaskStatus;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  startedAt: Date;
  finishedAt?: Date;
  _reported?: boolean; // 内部标记：是否已向 LLM 报告过完成状态
}

// ── 全局状态 ────────────────────────────────────────────────────────────────

const tasks = new Map<string, BackgroundTask>();
let taskCounter = 0;

// ── 核心函数 ────────────────────────────────────────────────────────────────

/**
 * 在后台启动一个 shell 命令，返回 taskId。
 * 命令的输出会累积到 stdout/stderr 中，可通过 check_background 查询。
 */
export function backgroundRun(command: string): string {
  const taskId = `bg_${++taskCounter}`;

  const task: BackgroundTask = {
    command,
    status: "running",
    stdout: "",
    stderr: "",
    exitCode: null,
    startedAt: new Date(),
  };
  tasks.set(taskId, task);

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

  child.on("close", (code: number | null) => {
    task.status = code === 0 ? "completed" : "failed";
    task.exitCode = code;
    task.finishedAt = new Date();
  });

  child.on("error", (err: Error) => {
    task.status = "failed";
    task.exitCode = -1;
    task.stderr += err.message;
    task.finishedAt = new Date();
  });

  return taskId;
}

/**
 * 查询指定后台任务的状态和输出。
 * 任务完成时会返回完整 stdout/stdout，未完成时只返回状态信息。
 */
export function checkBackground(taskId: string): string {
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
    startedAt: task.startedAt.toISOString(),
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
    result.finishedAt = task.finishedAt?.toISOString();
  }

  return JSON.stringify(result, null, 2);
}

/**
 * 获取所有已完成（非 running）的任务及其摘要。
 * 用于 agent loop 在每次 LLM call 前注入结果。
 */
export function getCompletedTasksSummaries(): string[] {
  const summaries: string[] = [];
  for (const [id, task] of tasks) {
    if (task.status === "running") continue;
    if (task.status === "completed" && !task._reported) {
      task._reported = true;
      const preview = task.stdout.slice(0, 500);
      summaries.push(
        `【后台任务完成】ID: ${id}\n命令: ${task.command}\n输出: ${preview}`,
      );
    } else if (task.status === "failed" && !task._reported) {
      task._reported = true;
      const preview = task.stderr.slice(0, 500);
      summaries.push(
        `【后台任务失败】ID: ${id}\n命令: ${task.command}\n错误: ${preview}`,
      );
    }
  }
  return summaries;
}

/** 清除所有已完成的后台任务记录 */
export function clearCompletedTasks(): void {
  for (const [id, task] of tasks) {
    if (task.status !== "running") tasks.delete(id);
  }
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



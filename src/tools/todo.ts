import { TaskManager } from "../task";

const taskManager = new TaskManager();

interface TaskTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
  handler: (args: Record<string, any>) => Promise<string> | string;
}

/** 任务工具定义数组 — 由 tools/index.ts 注册 */
export const taskTools: TaskTool[] = [
  {
    name: "task_create",
    description: "创建一个新任务。blockedBy 指定依赖哪些任务（用它们的 id），这些任务完成后本任务才能进行。",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "任务描述" },
        blockedBy: {
          type: "array",
          items: { type: "string" },
          description: "依赖的任务 id 列表（可选），如 ['1', '2']",
        },
      },
      required: ["text"],
    },
    handler: async (args) => {
      const task = taskManager.create(args.text, args.blockedBy ?? []);
      return `创建任务 #${task.id}: ${task.text}`;
    },
  },
  {
    name: "task_update",
    description: "更新任务的状态、文本或依赖关系。完成时自动解除下游依赖。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "任务 id" },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed"],
          description: "新状态",
        },
        text: { type: "string", description: "新描述" },
        addBlockedBy: {
          type: "array",
          items: { type: "string" },
          description: "添加依赖的任务 id",
        },
        removeBlockedBy: {
          type: "array",
          items: { type: "string" },
          description: "移除依赖的任务 id",
        },
      },
      required: ["id"],
    },
    handler: async (args) => {
      const task = taskManager.update(args.id, args);
      if (!task) return `任务 #${args.id} 不存在`;
      return `更新任务 #${args.id}: ${task.status} — ${task.text}${task.blockedBy.length > 0 ? ` (等待: ${task.blockedBy.map(d => `#${d}`).join(", ")})` : ""}`;
    },
  },
  {
    name: "task_list",
    description: "列出所有任务及其状态和依赖关系。",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    handler: async () => {
      return taskManager.formatList();
    },
  },
  {
    name: "task_delete",
    description: "删除一个任务，并自动从其他任务的依赖中移除它。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "任务 id" },
      },
      required: ["id"],
    },
    handler: async (args) => {
      const existed = taskManager.delete(args.id);
      return existed ? `已删除任务 #${args.id}` : `任务 #${args.id} 不存在`;
    },
  },
];

// ── 兼容旧代码的导出（agent.ts 仍引用这些） ──

/** @deprecated 用 taskTools 替代 */
export const TODO_DEFINITION = {
  type: "function" as const,
  function: {
    name: "todo",
    description: "[DEPRECATED] 用 task_create / task_update / task_list / task_delete 替代。管理当前任务列表。",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["id", "text", "status"],
          },
        },
      },
      required: ["items"],
    },
  },
};

/** @deprecated 用 taskTools 替代 */
export const TODO = {
  _items: [] as Array<{ id: string; text: string; status: string }>,
  update(items: Array<{ id: string; text: string; status: string }>) {
    this._items = items;
    const lines = items.map((t) => {
      const icon = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]";
      return `${icon} ${t.id}: ${t.text}`;
    });
    return lines.join("\n");
  },
};

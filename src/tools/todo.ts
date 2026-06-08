// ── TodoManager ──────────────────────────────────────────────────────────────

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
}

/**
 * 会话内 Todo 状态机。
 * 规则：同一时间最多一个 in_progress 项目，最多 20 条。
 */
export class TodoManager {
  private items: TodoItem[] = [];

  /**
   * 用新列表完整替换当前状态，返回渲染后的字符串供 LLM 确认。
   * 违反约束时抛出错误（工具层捕获并返回给 LLM）。
   */
  update(items: unknown[]): string {
    if (items.length > 20) {
      throw new Error("Max 20 todos allowed.");
    }
    const validated: TodoItem[] = [];
    let inProgressCount = 0;

    for (const raw of items) {
      const item = raw as Record<string, unknown>;
      const id     = String(item.id   ?? "");
      const text   = String(item.text ?? "").trim();
      const status = String(item.status ?? "pending") as TodoStatus;

      if (!text) throw new Error(`Item "${id}": text required.`);
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Item "${id}": invalid status "${status}". Must be pending | in_progress | completed.`);
      }
      if (status === "in_progress") inProgressCount++;

      validated.push({ id, text, status });
    }

    if (inProgressCount > 1) {
      throw new Error("Only one task can be in_progress at a time.");
    }

    this.items = validated;
    return this.render();
  }

  /** 返回人类可读的 todo 列表字符串，末行附进度计数 */
  render(): string {
    if (this.items.length === 0) return "No todos.";
    const lines = this.items.map((item) => {
      const icon =
        item.status === "completed"  ? "[x]" :
        item.status === "in_progress" ? "[>]" :
                                        "[ ]";
      return `${icon} #${item.id}: ${item.text}`;
    });
    const done = this.items.filter((t) => t.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);
    return lines.join("\n");
  }

  getItems(): TodoItem[] {
    return this.items;
  }
}

// 单例：整个进程生命周期内共享同一个 TodoManager
export const TODO = new TodoManager();

// ── 工具定义 ─────────────────────────────────────────────────────────────────

export const TODO_DEFINITION = {
  type: "function" as const,
  function: {
    name: "todo",
    description:
      "Track multi-step task progress. Call this at the start of a task to outline steps, " +
      "then update as you go. Exactly one item may be in_progress at a time.",
    parameters: {
      type: "object" as const,
      properties: {
        items: {
          type: "array",
          description: "Full replacement list of todo items.",
          items: {
            type: "object",
            properties: {
              id:     { type: "string", description: "Short unique identifier, e.g. '1' or 'step-a'" },
              text:   { type: "string", description: "Description of the task" },
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

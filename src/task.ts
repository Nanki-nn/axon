import * as fs from "fs";
import * as path from "path";
import { getTasksDir } from "./project-paths";

export interface Task {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed";
  blockedBy: string[];
  createdAt: number;
  updatedAt: number;
}

export class TaskManager {
  private tasks: Map<string, Task> = new Map();
  private tasksDir: string;

  constructor() {
    this.tasksDir = getTasksDir();
    if (!fs.existsSync(this.tasksDir)) {
      fs.mkdirSync(this.tasksDir, { recursive: true });
    }
    this._loadAll();
    this._printProgress();
  }

  /** 创建新任务 */
  create(text: string, blockedBy: string[] = []): Task {
    const id = this._nextId();
    const task: Task = {
      id,
      text,
      status: blockedBy.length > 0 ? "pending" : "pending",
      blockedBy,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.tasks.set(id, task);
    this._save(task);
    this._printProgress();
    return task;
  }

  /** 获取单个任务 */
  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  /** 更新任务状态 / 文本 / 依赖 */
  update(id: string, updates: {
    status?: "pending" | "in_progress" | "completed";
    text?: string;
    addBlockedBy?: string[];
    removeBlockedBy?: string[];
  }): Task | null {
    const task = this.tasks.get(id);
    if (!task) return null;

    if (updates.text !== undefined) task.text = updates.text;
    if (updates.status !== undefined) task.status = updates.status;
    if (updates.addBlockedBy) {
      for (const dep of updates.addBlockedBy) {
        if (!task.blockedBy.includes(dep)) {
          task.blockedBy.push(dep);
        }
      }
    }
    if (updates.removeBlockedBy) {
      task.blockedBy = task.blockedBy.filter((d) => !updates.removeBlockedBy!.includes(d));
    }

    task.updatedAt = Date.now();
    this._save(task);

    // 如果状态变为 completed，自动解除下游依赖
    if (updates.status === "completed") {
      this._clearDependency(id);
    }

    this._printProgress();
    return task;
  }

  /** 获取所有任务，按创建时间排序 */
  listAll(): Task[] {
    return Array.from(this.tasks.values())
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 删除任务 */
  delete(id: string): boolean {
    const existed = this.tasks.has(id);
    this.tasks.delete(id);
    this._removeFile(id);
    // 从其他任务的 blockedBy 中移除
    for (const task of this.tasks.values()) {
      if (task.blockedBy.includes(id)) {
        task.blockedBy = task.blockedBy.filter((d) => d !== id);
        this._save(task);
      }
    }
    this._printProgress();
    return existed;
  }

  /** 格式化输出，类似 [x] #[id]: text */
  formatList(): string {
    const all = this.listAll();
    if (all.length === 0) return "No tasks.";
    return all.map((t) => {
      const statusIcon = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]";
      const deps = t.blockedBy.length > 0 ? ` (blocked by: ${t.blockedBy.map(d => `#${d}`).join(", ")})` : "";
      return `${statusIcon} #${t.id}: ${t.text}${deps}`;
    }).join("\n");
  }

  // ─── 私有方法 ───

  private _nextId(): string {
    let max = 0;
    for (const key of this.tasks.keys()) {
      const n = parseInt(key, 10);
      if (n > max) max = n;
    }
    return String(max + 1);
  }

  private _taskPath(id: string): string {
    return path.join(this.tasksDir, `task_${id}.json`);
  }

  private _save(task: Task): void {
    fs.writeFileSync(this._taskPath(task.id), JSON.stringify(task, null, 2), "utf-8");
  }

  private _removeFile(id: string): void {
    const fp = this._taskPath(id);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }

  private _loadAll(): void {
    if (!fs.existsSync(this.tasksDir)) return;
    for (const file of fs.readdirSync(this.tasksDir)) {
      const match = file.match(/^task_(\d+)\.json$/);
      if (!match) continue;
      const fp = path.join(this.tasksDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
        this.tasks.set(data.id, data as Task);
      } catch {
        // 忽略损坏的文件
      }
    }
  }

  /** 当任务 id 完成时，从所有下游任务的 blockedBy 中移除它 */
  private _clearDependency(completedId: string): void {
    for (const task of this.tasks.values()) {
      if (task.blockedBy.includes(completedId)) {
        task.blockedBy = task.blockedBy.filter((d) => d !== completedId);
        task.updatedAt = Date.now();
        this._save(task);
      }
    }
  }

  /** 在终端打印任务进度概览 */
  private _printProgress(): void {
    const all = this.listAll();
    if (all.length === 0) return;

    const total = all.length;
    const completed = all.filter((t) => t.status === "completed").length;
    const inProgress = all.filter((t) => t.status === "in_progress").length;
    const pending = all.filter((t) => t.status === "pending").length;

    const barWidth = 20;
    const filled = Math.round((completed / total) * barWidth);
    const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);

    const lines: string[] = [];
    lines.push(`\n── Tasks ─────────────────────────────────`);
    lines.push(` ${bar} ${completed}/${total} (${inProgress} in progress, ${pending} pending)`);

    for (const t of all) {
      const icon = t.status === "completed" ? "✅" : t.status === "in_progress" ? "▶️" : "⏳";
      const deps = t.blockedBy.length > 0 ? ` [wait: #${t.blockedBy.join(", #")}]` : "";
      lines.push(`  ${icon} #${t.id}: ${t.text}${deps}`);
    }
    lines.push(` ─────────────────────────────────────\n`);

    console.log(lines.join("\n"));
  }
}

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { TaskManager } from "../task";

const TASKS_DIR = path.join(process.cwd(), ".tasks");

describe("TaskManager", () => {
  let tm: TaskManager;

  beforeAll(() => {
    // 清空 .tasks 测试前状态
    if (fs.existsSync(TASKS_DIR)) {
      for (const f of fs.readdirSync(TASKS_DIR)) {
        fs.unlinkSync(path.join(TASKS_DIR, f));
      }
    }
    tm = new TaskManager();
  });

  afterAll(() => {
    // 清理测试数据
    if (fs.existsSync(TASKS_DIR)) {
      for (const f of fs.readdirSync(TASKS_DIR)) {
        fs.unlinkSync(path.join(TASKS_DIR, f));
      }
      fs.rmdirSync(TASKS_DIR);
    }
  });

  it("创建任务并持久化到磁盘", () => {
    const t = tm.create("测试任务");
    expect(t.id).toBe("1");
    expect(t.text).toBe("测试任务");
    expect(t.status).toBe("pending");

    // 验证磁盘文件
    const filePath = path.join(TASKS_DIR, "task_1.json");
    expect(fs.existsSync(filePath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(data.text).toBe("测试任务");
  });

  it("创建依赖任务", () => {
    const t1 = tm.create("父任务");
    const t2 = tm.create("子任务", [t1.id]);
    expect(t2.blockedBy).toEqual([t1.id]);
  });

  it("更新任务状态", () => {
    const t = tm.create("待更新");
    const updated = tm.update(t.id, { status: "in_progress" });
    expect(updated?.status).toBe("in_progress");
  });

  it("完成任务自动解除下游依赖", () => {
    const parent = tm.create("依赖根");
    const child = tm.create("依赖子任务", [parent.id]);
    expect(child.blockedBy).toContain(parent.id);

    tm.update(parent.id, { status: "completed" });

    // 重新读取 child，验证 blockedBy 已清除
    const updatedChild = tm.get(child.id);
    expect(updatedChild?.blockedBy).not.toContain(parent.id);
  });

  it("列出所有任务", () => {
    const all = tm.listAll();
    expect(all.length).toBeGreaterThan(0);
    const output = tm.formatList();
    expect(output).toContain("#");
  });

  it("删除任务", () => {
    const t = tm.create("将被删除");
    const filePath = path.join(TASKS_DIR, `task_${t.id}.json`);
    expect(fs.existsSync(filePath)).toBe(true);
    tm.delete(t.id);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(tm.get(t.id)).toBeUndefined();
  });

  it("重启后从磁盘恢复任务", () => {
    tm.create("持久化测试");
    const tm2 = new TaskManager();
    const all = tm2.listAll();
    expect(all.some((t) => t.text === "持久化测试")).toBe(true);
  });
});

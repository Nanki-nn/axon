import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import {
  formatMemoriesForInjection,
  getMemoryIndexPath,
  getStructuredMemoryDir,
  listMemories,
  memoryToolHandlers,
  recallMemories,
  readMemory,
  saveMemory,
} from "../features/memory";

const TEST_MEMORY_DIR = join(process.cwd(), ".tmp", "memory-test");

function cleanMemory(): void {
  if (existsSync(TEST_MEMORY_DIR)) {
    rmSync(TEST_MEMORY_DIR, { recursive: true, force: true });
  }
}

describe("structured memory", () => {
  beforeEach(() => {
    process.env.AXON_MEMORY_DIR = TEST_MEMORY_DIR;
    cleanMemory();
  });

  afterEach(() => {
    cleanMemory();
    delete process.env.AXON_MEMORY_DIR;
  });

  it("保存记忆并维护 MEMORY.md 索引", () => {
    const filename = saveMemory({
      name: "release direction",
      description: "Axon should prepare for public beta release.",
      type: "project",
      content: "Focus on safety, onboarding, and reliable npm packaging.",
    });

    expect(filename).toBe("project_release_direction.md");
    expect(listMemories()).toHaveLength(1);
    expect(readMemory(filename)).toContain("Focus on safety");

    const index = readFileSync(getMemoryIndexPath(), "utf-8");
    expect(index).toContain("release direction");
    expect(index).toContain(filename);
  });

  it("通过工具保存、读取、列出和删除记忆", () => {
    const saved = memoryToolHandlers.memory_save({
      name: "concise answers",
      description: "User prefers concise final answers.",
      type: "feedback",
      content: "Keep final answers short unless the user asks for detail.",
    });
    expect(saved).toContain("feedback_concise_answers.md");

    const listed = memoryToolHandlers.memory_list({});
    expect(listed).toContain("[feedback]");
    expect(listed).toContain("concise answers");

    const read = memoryToolHandlers.memory_read({ filename: "feedback_concise_answers.md" });
    expect(read).toContain("Keep final answers short");

    const deleted = memoryToolHandlers.memory_delete({ filename: "feedback_concise_answers.md" });
    expect(deleted).toContain("Memory deleted");
    expect(memoryToolHandlers.memory_list({})).toContain("No structured memories");
  });

  it("根据 sideQuery 选择相关记忆并格式化注入内容", async () => {
    const filename = saveMemory({
      name: "memory architecture",
      description: "Axon memory should use structured markdown files.",
      type: "project",
      content: "Use MEMORY.md index and semantic recall.",
    });

    const memories = await recallMemories(
      "继续实现 axon memory architecture",
      async (_system, userMessage) => {
        expect(userMessage).toContain(filename);
        return JSON.stringify({ selected_memories: [filename] });
      },
      new Set(),
      0,
    );

    expect(memories).toHaveLength(1);
    expect(memories[0].content).toContain("semantic recall");

    const injection = formatMemoriesForInjection(memories);
    expect(injection).toContain("<system-reminder>");
    expect(injection).toContain(getStructuredMemoryDir());
  });

  it("短查询不触发召回", async () => {
    saveMemory({
      name: "short query gate",
      description: "Should not be selected for tiny inputs.",
      type: "project",
      content: "Tiny inputs skip recall.",
    });

    const memories = await recallMemories(
      "ok",
      async () => {
        throw new Error("sideQuery should not run");
      },
      new Set(),
      0,
    );

    expect(memories).toEqual([]);
  });
});

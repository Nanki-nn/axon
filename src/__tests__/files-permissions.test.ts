import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { editFile, readFile, resetFileReadState, writeFile } from "../tools/files";

const TEST_DIR = join(process.cwd(), ".tmp", "files-permissions-test");

function clean(): void {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  resetFileReadState();
}

describe("file safety", () => {
  beforeEach(() => {
    clean();
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(clean);

  it("写入已有文件前必须先读取", () => {
    const filePath = join(TEST_DIR, "a.txt");
    writeFileSync(filePath, "old");

    const result = writeFile(filePath, "new");
    expect(result).toContain("must read");
    expect(readFileSync(filePath, "utf-8")).toBe("old");
  });

  it("读取后如果 mtime 变化，需要重新读取才能编辑", () => {
    const filePath = join(TEST_DIR, "b.txt");
    writeFileSync(filePath, "old");
    expect(readFile(filePath)).toBe("old");

    writeFileSync(filePath, "changed externally");
    const result = editFile(filePath, "changed", "updated");
    expect(result).toContain("modified externally");
  });

  it("读取后允许编辑未被外部修改的文件", () => {
    const filePath = join(TEST_DIR, "c.txt");
    writeFileSync(filePath, "hello old");
    expect(readFile(filePath)).toBe("hello old");

    const result = editFile(filePath, "old", "new");
    expect(result).toContain("Edited");
    expect(readFileSync(filePath, "utf-8")).toBe("hello new");
  });
});

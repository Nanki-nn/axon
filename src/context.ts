import * as fs from "fs";
import * as path from "path";

// AGENTS.md 单文件内容上限，防止撑爆 context window
const MAX_BYTES = 32 * 1024;

/**
 * 从 git 根目录向当前工作目录逐层查找 AGENTS.md。
 * 找到的文件按 根→叶 顺序拼接，总大小不超过 MAX_BYTES。
 *
 * 设计参考 Kode-CLI 的层级上下文发现策略：
 * 根目录的 AGENTS.md 写全局规范，子目录的写局部覆盖，
 * 越靠近当前目录优先级越高（后拼接，模型更容易关注）。
 */
export function loadAgentsContext(cwd: string = process.cwd()): string {
  // 找 git 根目录，找不到就用 cwd 作为起点
  const gitRoot = findGitRoot(cwd) ?? cwd;

  // 收集从 gitRoot 到 cwd 的所有目录层级
  const dirs = collectDirs(gitRoot, cwd);

  const chunks: string[] = [];
  let totalBytes = 0;

  for (const dir of dirs) {
    // 优先读 AGENTS.override.md，其次 AGENTS.md
    const file = findAgentsFile(dir);
    if (!file) continue;

    const content = fs.readFileSync(file, "utf-8").trim();
    if (!content) continue;

    const bytes = Buffer.byteLength(content, "utf-8");

    // 超出上限就截断，不再继续
    if (totalBytes + bytes > MAX_BYTES) {
      const remaining = MAX_BYTES - totalBytes;
      if (remaining > 0) {
        chunks.push(content.slice(0, remaining) + "\n...(内容过长已截断)");
      }
      break;
    }

    chunks.push(`# 来自 ${path.relative(cwd, file) || "AGENTS.md"}\n${content}`);
    totalBytes += bytes;
  }

  return chunks.join("\n\n");
}

// ── 内部工具函数 ──────────────────────────────────────────────────────────────

/** 向上查找包含 .git 目录的根路径 */
function findGitRoot(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // 到达文件系统根目录
    dir = parent;
  }
}

/** 收集从 rootDir 到 targetDir 的所有目录，按层级从浅到深排列 */
function collectDirs(rootDir: string, targetDir: string): string[] {
  const dirs: string[] = [];
  let dir = targetDir;

  // 从 targetDir 往上走直到 rootDir，收集路径
  while (true) {
    dirs.unshift(dir); // 插到头部，保证根→叶顺序
    if (dir === rootDir) break;
    const parent = path.dirname(dir);
    if (parent === dir) break; // 防止死循环
    dir = parent;
  }

  return dirs;
}

/** 在指定目录下查找 AGENTS.override.md 或 AGENTS.md */
function findAgentsFile(dir: string): string | null {
  for (const name of ["AGENTS.override.md", "AGENTS.md"]) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

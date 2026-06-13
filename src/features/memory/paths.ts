/**
 * 项目级别的记忆存储路径，默认在用户目录下的 .axon/projects/{projectHash}/memory 目录中。
 */

import { createHash } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

function getProjectHash(): string {
  return createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
}

export function getStructuredMemoryDir(): string {
  const dir = process.env.AXON_MEMORY_DIR ||
    join(homedir(), ".axon", "projects", getProjectHash(), "memory");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function getMemoryIndexPath(): string {
  return join(getStructuredMemoryDir(), "MEMORY.md");
}

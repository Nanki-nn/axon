import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { getStructuredMemoryDirPath } from "../../project-paths";

export function getStructuredMemoryDir(): string {
  const dir = getStructuredMemoryDirPath();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function getMemoryIndexPath(): string {
  return join(getStructuredMemoryDir(), "MEMORY.md");
}

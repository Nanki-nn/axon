import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { parseFrontmatter, formatFrontmatter } from "./frontmatter";
import { getMemoryIndexPath, getStructuredMemoryDir } from "./paths";
import { MemoryEntry, MemoryHeader, MemoryType } from "./types";

const VALID_TYPES = new Set<MemoryType>(["user", "feedback", "project", "reference"]);
const MAX_INDEX_LINES = 200;
const MAX_INDEX_BYTES = 25_000;
const MAX_MEMORY_FILES = 200;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40) || "memory";
}

function validateType(type: string): MemoryType {
  return VALID_TYPES.has(type as MemoryType) ? type as MemoryType : "project";
}

export function listMemories(): MemoryEntry[] {
  const dir = getStructuredMemoryDir();
  const files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
  const entries: MemoryEntry[] = [];

  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), "utf-8");
      const { meta, body } = parseFrontmatter(raw);
      if (!meta.name || !meta.type) continue;
      entries.push({
        name: meta.name,
        description: meta.description || "",
        type: validateType(meta.type),
        filename: file,
        content: body,
      });
    } catch {
      // 忽略损坏的记忆文件。
    }
  }

  entries.sort((a, b) => {
    try {
      return statSync(join(dir, b.filename)).mtimeMs - statSync(join(dir, a.filename)).mtimeMs;
    } catch {
      return 0;
    }
  });
  return entries;
}

export function saveMemory(entry: Omit<MemoryEntry, "filename">): string {
  const dir = getStructuredMemoryDir();
  const type = validateType(entry.type);
  const filename = `${type}_${slugify(entry.name)}.md`;
  const content = formatFrontmatter({
    name: entry.name,
    description: entry.description,
    type,
  }, entry.content);

  writeFileSync(join(dir, filename), content, "utf-8");
  updateMemoryIndex();
  return filename;
}

export function readMemory(filename: string): string | null {
  if (filename.includes("/") || filename.includes("\\")) return null;
  const filePath = join(getStructuredMemoryDir(), filename);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, "utf-8");
}

export function deleteMemory(filename: string): boolean {
  if (filename.includes("/") || filename.includes("\\")) return false;
  const filePath = join(getStructuredMemoryDir(), filename);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  updateMemoryIndex();
  return true;
}

export function updateMemoryIndex(): void {
  const lines = ["# Memory Index", ""];
  for (const memory of listMemories()) {
    lines.push(`- **[${memory.name}](${memory.filename})** (${memory.type}) — ${memory.description}`);
  }
  writeFileSync(getMemoryIndexPath(), lines.join("\n"), "utf-8");
}

export function loadMemoryIndex(): string {
  const indexPath = getMemoryIndexPath();
  if (!existsSync(indexPath)) return "";
  let content = readFileSync(indexPath, "utf-8");

  const lines = content.split("\n");
  if (lines.length > MAX_INDEX_LINES) {
    content = lines.slice(0, MAX_INDEX_LINES).join("\n") +
      "\n\n[... truncated, too many memory entries ...]";
  }
  if (Buffer.byteLength(content) > MAX_INDEX_BYTES) {
    content = content.slice(0, MAX_INDEX_BYTES) +
      "\n\n[... truncated, index too large ...]";
  }
  return content;
}

export function scanMemoryHeaders(): MemoryHeader[] {
  const dir = getStructuredMemoryDir();
  const files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
  const headers: MemoryHeader[] = [];

  for (const file of files) {
    try {
      const filePath = join(dir, file);
      const raw = readFileSync(filePath, "utf-8");
      const first30 = raw.split("\n").slice(0, 30).join("\n");
      const { meta } = parseFrontmatter(first30);
      headers.push({
        filename: file,
        filePath,
        mtimeMs: statSync(filePath).mtimeMs,
        description: meta.description || null,
        type: meta.type ? validateType(meta.type) : undefined,
      });
    } catch {
      // 忽略损坏的记忆文件。
    }
  }

  headers.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return headers.slice(0, MAX_MEMORY_FILES);
}

export function formatMemoryManifest(headers: MemoryHeader[]): string {
  return headers.map((header) => {
    const tag = header.type ? `[${header.type}] ` : "";
    const timestamp = new Date(header.mtimeMs).toISOString();
    return header.description
      ? `- ${tag}${header.filename} (${timestamp}): ${header.description}`
      : `- ${tag}${header.filename} (${timestamp})`;
  }).join("\n");
}

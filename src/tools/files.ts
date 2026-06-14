import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "fs";
import { dirname, resolve, relative } from "path";
import { spawnSync } from "child_process";
import { globSync } from "glob";

/**
 * 文件操作工具集
 * 提供安全的文件读写、编辑、列举和搜索功能，限定在工作区内，防止路径穿越攻击。
 */

const WORKDIR = process.cwd();
const readFileState = new Map<string, number>();

function safePath(p: string): string {
  const abs = resolve(WORKDIR, p);
  if (!abs.startsWith(WORKDIR + "/") && abs !== WORKDIR) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return abs;
}

function rememberRead(abs: string): void {
  try {
    readFileState.set(abs, statSync(abs).mtimeMs);
  } catch {
    // 文件可能在读取后立即被删除，忽略即可。
  }
}

function ensureFreshForWrite(abs: string, displayPath: string, action: "writing" | "editing"): string | null {
  if (!existsSync(abs)) return null;
  if (!readFileState.has(abs)) {
    return `Error: You must read ${displayPath} before ${action}. Use read_file first to inspect current contents.`;
  }

  const currentMtime = statSync(abs).mtimeMs;
  const lastReadMtime = readFileState.get(abs);
  if (currentMtime !== lastReadMtime) {
    return `Warning: ${displayPath} was modified externally since your last read. Read it again before ${action}.`;
  }
  return null;
}

// ── 工具定义（OpenAI function calling 格式，传给 LLM）─────────────────────────

export const READ_DEFINITION = {
  type: "function" as const,
  function: {
    name: "read_file",
    description: "Read the full contents of a file. Always read before editing.",
    parameters: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Path to the file" },
      },
      required: ["path"],
    },
  },
};

export const WRITE_DEFINITION = {
  type: "function" as const,
  function: {
    name: "write_file",
    description: "Write content to a file, creating it if it doesn't exist.",
    parameters: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Path to the file" },
        content: { type: "string", description: "Full content to write" },
      },
      required: ["path", "content"],
    },
  },
};

export const EDIT_DEFINITION = {
  type: "function" as const,
  function: {
    name: "edit_file",
    description:
      "Replace an exact string in a file with new content. " +
      "Read the file first to get the exact text.",
    parameters: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Path to the file" },
        old_string: { type: "string", description: "Exact string to replace" },
        new_string: { type: "string", description: "Replacement string" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
};

export const LIST_DEFINITION = {
  type: "function" as const,
  function: {
    name: "list_files",
    description: "List files matching a glob pattern.",
    parameters: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern, e.g. '**/*.ts' or 'src/*.ts'",
        },
      },
      required: ["pattern"],
    },
  },
};

export const SEARCH_DEFINITION = {
  type: "function" as const,
  function: {
    name: "search_files",
    description: "Search for a regex pattern across files using grep.",
    parameters: {
      type: "object" as const,
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: {
          type: "string",
          description: "Directory or file to search in (default: .)",
        },
      },
      required: ["pattern"],
    },
  },
};

// ── 工具实现 ──────────────────────────────────────────────────────────────────

const READ_LIMIT_BYTES = 50_000;

/** 读取文件内容，出错时返回错误信息字符串而非抛出异常 */
export function readFile(path: string): string {
  try {
    const abs = safePath(path);
    const text = readFileSync(abs, "utf-8");
    rememberRead(abs);
    return text.length > READ_LIMIT_BYTES ? text.slice(0, READ_LIMIT_BYTES) + "\n[truncated]" : text;
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}

function normalizeQuotes(value: string): string {
  return value
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, "\"");
}

function findActualString(fileContent: string, searchString: string): { actual: string; quoteNormalized: boolean } | null {
  if (fileContent.includes(searchString)) return { actual: searchString, quoteNormalized: false };

  const normalizedSearch = normalizeQuotes(searchString);
  const normalizedFile = normalizeQuotes(fileContent);
  const idx = normalizedFile.indexOf(normalizedSearch);
  if (idx === -1) return null;

  return {
    actual: fileContent.slice(idx, idx + searchString.length),
    quoteNormalized: true,
  };
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let searchIdx = 0;
  while ((searchIdx = content.indexOf(needle, searchIdx)) !== -1) {
    count++;
    searchIdx += needle.length;
  }
  return count;
}

function generateEditDiff(original: string, oldString: string, newString: string): string {
  const start = original.indexOf(oldString);
  if (start === -1) return "";

  const startLine = original.slice(0, start).split("\n").length;
  const oldLines = oldString.split("\n");
  const newLines = newString.split("\n");
  const removed = oldLines.map((line) => `- ${line}`).join("\n");
  const added = newLines.map((line) => `+ ${line}`).join("\n");
  return [
    `@@ -${startLine},${oldLines.length} +${startLine},${newLines.length} @@`,
    removed,
    added,
  ].join("\n");
}

/** 写入文件，自动创建父目录，返回写入字节数确认 */
export function writeFile(path: string, content: string): string {
  try {
    const abs = safePath(path);
    const freshnessError = ensureFreshForWrite(abs, path, "writing");
    if (freshnessError) return freshnessError;

    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf-8");
    rememberRead(abs);
    return `Written ${content.length} bytes to ${abs}`;
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}

/**
 * 精确字符串替换：要求 old_string 在文件中有且只有一处匹配。
 * 多处匹配时报错（需要 LLM 提供更多上下文来唯一定位），避免误改。
 */
export function editFile(path: string, oldString: string, newString: string): string {
  try {
    const abs = safePath(path);
    const freshnessError = ensureFreshForWrite(abs, path, "editing");
    if (freshnessError) return freshnessError;

    const original = readFileSync(abs, "utf-8");
    const match = findActualString(original, oldString);
    if (!match) {
      return `Error: old_string not found in ${path}`;
    }
    // 统计出现次数，超过 1 次时拒绝执行
    const count = countOccurrences(original, match.actual);
    if (count > 1) {
      return `Error: old_string appears ${count} times in ${path}. Provide more surrounding context to make the match unique.`;
    }
    writeFileSync(abs, original.replace(match.actual, newString), "utf-8");
    rememberRead(abs);
    const quoteNote = match.quoteNormalized ? " (matched via quote normalization)" : "";
    const diff = generateEditDiff(original, match.actual, newString);
    return `Edited ${relative(WORKDIR, abs) || abs}${quoteNote}\n\n${diff}`;
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}

/** 使用 glob 模式列举文件，结果按字母排序，cwd 限定在工作区内 */
export function listFiles(pattern: string): string {
  const matches = globSync(pattern, { cwd: WORKDIR });
  return matches.length ? matches.sort().join("\n") : `No files matched: ${pattern}`;
}

/**
 * 用 grep 在指定目录/文件中搜索正则。
 * 使用 spawnSync 而不是 execSync，避免用户提供的 pattern 造成 shell 注入。
 */
export function searchFiles(pattern: string, searchPath: string = "."): string {
  let absSearchPath: string;
  try {
    absSearchPath = safePath(searchPath);
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
  const result = spawnSync("grep", ["-rn", pattern, absSearchPath], {
    encoding: "utf-8",
    timeout: 15_000,
  });
  if (result.error) return `Error: ${result.error.message}`;
  const output = (result.stdout ?? "").trim();
  return output || `No matches for: ${pattern}`;
}

export function resetFileReadState(): void {
  readFileState.clear();
}

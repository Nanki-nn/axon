import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { spawnSync } from "child_process";
import { globSync } from "glob";

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

export function readFile(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}

export function writeFile(path: string, content: string): string {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf-8");
    return `Written ${content.length} bytes to ${path}`;
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}

export function editFile(path: string, oldString: string, newString: string): string {
  try {
    const original = readFileSync(path, "utf-8");
    if (!original.includes(oldString)) {
      return `Error: old_string not found in ${path}`;
    }
    // Count occurrences to detect ambiguous replacements
    let count = 0;
    let searchIdx = 0;
    while ((searchIdx = original.indexOf(oldString, searchIdx)) !== -1) {
      count++;
      searchIdx += oldString.length;
    }
    if (count > 1) {
      return `Error: old_string appears ${count} times in ${path}. Provide more surrounding context to make the match unique.`;
    }
    writeFileSync(path, original.replace(oldString, newString), "utf-8");
    return `Edited ${path}`;
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}

export function listFiles(pattern: string): string {
  const matches = globSync(pattern);
  return matches.length ? matches.sort().join("\n") : `No files matched: ${pattern}`;
}

export function searchFiles(pattern: string, searchPath: string = "."): string {
  // Use spawnSync to avoid shell injection from user-supplied pattern
  const result = spawnSync("grep", ["-rn", pattern, searchPath], {
    encoding: "utf-8",
    timeout: 15_000,
  });
  if (result.error) return `Error: ${result.error.message}`;
  const output = (result.stdout ?? "").trim();
  return output || `No matches for: ${pattern}`;
}

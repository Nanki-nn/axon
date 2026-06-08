import { DEFINITION as BASH_DEF, execute as bashExecute } from "./bash";
import {
  READ_DEFINITION, WRITE_DEFINITION, EDIT_DEFINITION, LIST_DEFINITION, SEARCH_DEFINITION,
  readFile, writeFile, editFile, listFiles, searchFiles,
} from "./files";
import { SkillLoader } from "../skills";

// 当前会话的技能加载器，由 cli.ts 在启动时注入
let skillLoader: SkillLoader | null = null;

// MCP 工具注册表：工具全名（serverName__toolName）→ 调用函数
const mcpDispatchers = new Map<string, (input: Record<string, string>) => Promise<string>>();
// MCP 工具的 OpenAI function definition 列表（动态追加到 DEFINITIONS）
const mcpDefinitions: object[] = [];

/** 注入技能加载器（仅在 cli.ts 启动阶段调用一次） */
export function setSkillLoader(loader: SkillLoader): void {
  skillLoader = loader;
}

/**
 * 注册一个来自 MCP 服务端的工具。
 * definition 遵循 OpenAI function calling 格式，dispatcher 负责实际调用。
 */
export function registerMcpTool(
  definition: object,
  dispatcher: (input: Record<string, string>) => Promise<string>,
): void {
  const def = definition as { function?: { name?: string } };
  const name = def.function?.name;
  if (name) {
    mcpDefinitions.push(definition);
    mcpDispatchers.set(name, dispatcher);
  }
}

// ── 技能工具定义（供 LLM 发现和调用技能） ─────────────────────────────────────

const SKILL_LIST_DEFINITION = {
  type: "function" as const,
  function: {
    name: "skill_list",
    description: "List all available skills with their names and brief descriptions.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
};

const SKILL_READ_DEFINITION = {
  type: "function" as const,
  function: {
    name: "skill_read",
    description: "Load the full instructions for a named skill. Call skill_list first to discover available skills, then call this before tackling a matching task.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name to load" },
      },
      required: ["name"],
    },
  },
};

/**
 * 返回当前所有工具的定义列表（内置工具 + 动态注册的 MCP 工具）。
 * 每次调用都重新构建，确保 MCP 工具注册后能被包含进来。
 */
export function getDEFINITIONS(): object[] {
  return [
    BASH_DEF,
    READ_DEFINITION,
    WRITE_DEFINITION,
    EDIT_DEFINITION,
    LIST_DEFINITION,
    SEARCH_DEFINITION,
    SKILL_LIST_DEFINITION,
    SKILL_READ_DEFINITION,
    ...mcpDefinitions,
  ];
}

/**
 * DEFINITIONS 是一个 Proxy，让 agent.ts 可以在 MCP 工具注册前就持有引用，
 * 同时在每次访问时动态获取最新的工具列表。
 * 兼容 Array 访问模式（下标、length、迭代方法等）。
 */
export const DEFINITIONS = new Proxy([] as object[], {
  get(_, prop) {
    if (prop === "length") return getDEFINITIONS().length;
    const arr = getDEFINITIONS();
    if (typeof prop === "string" && !isNaN(Number(prop))) return arr[Number(prop)];
    // @ts-ignore
    return arr[prop as any] ?? (Array.prototype[prop as any]?.bind(arr));
  },
});

type ToolInput = Record<string, string>;

/**
 * 工具调用分发器：根据工具名找到对应的执行函数并调用。
 * MCP 工具优先（动态注册），其次是内置工具。
 */
export async function dispatch(name: string, input: ToolInput): Promise<string> {
  // 先查 MCP 注册表（动态注册的工具）
  if (mcpDispatchers.has(name)) {
    return mcpDispatchers.get(name)!(input);
  }

  // 内置工具按名称分发
  switch (name) {
    case "bash":         return bashExecute(input.command);
    case "read_file":    return readFile(input.path);
    case "write_file":   return writeFile(input.path, input.content);
    case "edit_file":    return editFile(input.path, input.old_string, input.new_string);
    case "list_files":   return listFiles(input.pattern);
    case "search_files": return searchFiles(input.pattern, input.path ?? ".");
    case "skill_list":   return skillLoader?.listSkills() ?? "Error: skill system not initialized";
    case "skill_read":   return skillLoader?.getContent(input.name) ?? "Error: skill system not initialized";
    default:             return `Error: unknown tool '${name}'`;
  }
}

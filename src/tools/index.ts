import { DEFINITION as BASH_DEF, execute as bashExecute } from "./bash";
import {
  READ_DEFINITION, WRITE_DEFINITION, EDIT_DEFINITION, LIST_DEFINITION, SEARCH_DEFINITION,
  readFile, writeFile, editFile, listFiles, searchFiles,
} from "./files";
import { TODO_DEFINITION, TODO, taskTools } from "./todo";
import { DEFINITION as COMPACT_DEF, execute as compactExecute } from "./compact";
import { SkillLoader } from "../skills";
import {
  teamToolHandlers,
  PARTNER_CREATE_DEFINITION,
  PARTNER_LIST_DEFINITION,
  PARTNER_REMOVE_DEFINITION,
  PARTNER_SEND_DEFINITION,
  PARTNER_READ_INBOX_DEFINITION,
  PARTNER_BROADCAST_DEFINITION,
  PARTNER_SPAWN_DEFINITION,
} from "./teams";
import {
  BACKGROUND_RUN_DEFINITION,
  CHECK_BACKGROUND_DEFINITION,
  backgroundRun,
  checkBackground,
} from "./background";

/**
 * 工具注册中心，管理所有可用工具的定义和调用分发。
 */


// 当前会话的技能加载器，由 cli.ts 在启动时注入
let skillLoader: SkillLoader | null = null;

// task 工具的执行函数，由 Session 在启动时注入（需要 client/model 才能运行子 agent）
let taskRunner: ((prompt: string, description: string) => Promise<string>) | null = null;

/** 注入 task 工具的执行函数 */
export function setTaskRunner(fn: (prompt: string, description: string) => Promise<string>): void {
  taskRunner = fn;
}

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

const TASK_DEFINITION = {
  type: "function" as const,
  function: {
    name: "task",
    description:
      "Spawn a subagent with a fresh context to handle exploration or a self-contained subtask. " +
      "The subagent shares the filesystem but not conversation history. " +
      "Only its final summary is returned — use this to keep parent context clean.",
    parameters: {
      type: "object" as const,
      properties: {
        prompt:      { type: "string", description: "Full instructions for the subagent" },
        description: { type: "string", description: "Short label shown in logs, e.g. 'explore auth module'" },
      },
      required: ["prompt"],
    },
  },
};

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
    TODO_DEFINITION,
    BACKGROUND_RUN_DEFINITION,
    CHECK_BACKGROUND_DEFINITION,
    ...taskTools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    })),
    COMPACT_DEF,
    TASK_DEFINITION,
    SKILL_LIST_DEFINITION,
    SKILL_READ_DEFINITION,
    PARTNER_CREATE_DEFINITION,
    PARTNER_LIST_DEFINITION,
    PARTNER_REMOVE_DEFINITION,
    PARTNER_SEND_DEFINITION,
    PARTNER_READ_INBOX_DEFINITION,
    PARTNER_BROADCAST_DEFINITION,
    PARTNER_SPAWN_DEFINITION,
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

type ToolInput = Record<string, any>;
type ToolHandler = (input: ToolInput) => Promise<string> | string;

// 内置工具 dispatch map：工具名 → 处理函数
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash:         (i) => bashExecute(i.command),
  read_file:    (i) => readFile(i.path),
  write_file:   (i) => writeFile(i.path, i.content),
  edit_file:    (i) => editFile(i.path, i.old_string, i.new_string),
  list_files:   (i) => listFiles(i.pattern),
  search_files: (i) => searchFiles(i.pattern, i.path ?? "."),
  todo:         (i) => { try { return TODO.update(i.items ?? []); } catch (e: any) { return `Error: ${e.message}`; } },
  task_create:  (i) => taskTools[0].handler(i),
  task_update:  (i) => taskTools[1].handler(i),
  task_list:    (_) => taskTools[2].handler({}),
  task_delete:  (i) => taskTools[3].handler(i),
  compact:      (i) => compactExecute(),
  task:         (i) => taskRunner
    ? taskRunner(i.prompt ?? "", i.description ?? "subtask")
    : "Error: task runner not initialized",
  skill_list:   (_) => skillLoader?.listSkills() ?? "Error: skill system not initialized",
  skill_read:   (i) => skillLoader?.getContent(i.name) ?? "Error: skill system not initialized",
  background_run:  (i) => { const taskId = backgroundRun(i.command); return JSON.stringify({ taskId, status: "running", note: "使用 check_background 查询结果" }); },
  check_background: (i) => checkBackground(i.taskId),
  ...teamToolHandlers,
};

/**
 * 工具调用分发器：根据工具名找到对应的执行函数并调用。
 * MCP 工具优先（动态注册），其次是内置工具。
 */
export async function dispatch(name: string, input: ToolInput): Promise<string> {
  if (mcpDispatchers.has(name)) {
    return mcpDispatchers.get(name)!(input);
  }
  const handler = TOOL_HANDLERS[name];
  return handler ? handler(input) : `Error: unknown tool '${name}'`;
}

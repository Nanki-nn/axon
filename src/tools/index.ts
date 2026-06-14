import { DEFINITION as BASH_DEF, execute as bashExecute } from "./bash";
import { confirm } from "./bash";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
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
import {
  MEMORY_SAVE_DEFINITION,
  MEMORY_LIST_DEFINITION,
  MEMORY_READ_DEFINITION,
  MEMORY_DELETE_DEFINITION,
  memoryToolHandlers,
} from "../features/memory";
import { auditToolCall, checkPermission, maskSecrets } from "../permissions";
import { getProjectAxonDir } from "../project-paths";

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

type ToolInput = Record<string, any>;
type ToolHandler = (input: ToolInput) => Promise<string> | string;

export interface ToolSpec {
  name: string;
  definition: object;
  handler?: ToolHandler;
  maxResultSizeChars?: number;
  deferred?: boolean;
  prompt?: string;
  isReadOnly?: (input: ToolInput) => boolean;
  isConcurrencySafe?: (input: ToolInput) => boolean;
  isDestructive?: (input: ToolInput) => boolean;
}

const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000;
const TOOL_RESULT_PERSIST_THRESHOLD_CHARS = 30_000;
const activatedDeferredTools = new Set<string>();

function functionName(definition: object): string {
  const def = definition as { function?: { name?: string } };
  return def.function?.name ?? "";
}

function spec(definition: object, handler: ToolHandler, options: Omit<ToolSpec, "name" | "definition" | "handler"> = {}): ToolSpec {
  return {
    name: functionName(definition),
    definition,
    handler,
    maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    ...options,
  };
}

function readOnly(definition: object, handler: ToolHandler, options: Omit<ToolSpec, "name" | "definition" | "handler" | "isReadOnly" | "isConcurrencySafe"> = {}): ToolSpec {
  return spec(definition, handler, {
    ...options,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
  });
}

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

const TOOL_SEARCH_DEFINITION = {
  type: "function" as const,
  function: {
    name: "tool_search",
    description:
      "Search deferred tools by name or keyword and activate matching tool schemas for the next model call.",
    parameters: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Tool name or keyword to search for" },
      },
      required: ["query"],
    },
  },
};

function createBuiltInToolSpecs(): ToolSpec[] {
  const taskSpecs = taskTools.map((t) => {
    const definition = {
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    };
    const taskReadOnly = t.name === "task_list";
    return spec(definition, (i) => t.handler(i), {
      isReadOnly: () => taskReadOnly,
      isConcurrencySafe: () => taskReadOnly,
    });
  });

  return [
    spec(BASH_DEF, (i) => bashExecute(i.command), {
      isReadOnly: (i) => /^\s*(pwd|ls|find|rg|grep|cat|sed|head|tail|wc|git\s+(status|diff|show|log|branch))\b/.test(String(i.command ?? "")),
    }),
    readOnly(READ_DEFINITION, (i) => readFile(i.path)),
    spec(WRITE_DEFINITION, (i) => writeFile(i.path, i.content)),
    spec(EDIT_DEFINITION, (i) => editFile(i.path, i.old_string, i.new_string)),
    readOnly(LIST_DEFINITION, (i) => listFiles(i.pattern)),
    readOnly(SEARCH_DEFINITION, (i) => searchFiles(i.pattern, i.path ?? ".")),
    spec(TODO_DEFINITION, (i) => {
      try {
        return TODO.update(i.items ?? []);
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }, { deferred: true }),
    spec(BACKGROUND_RUN_DEFINITION, (i) => {
      const taskId = backgroundRun(i.command);
      return JSON.stringify({ taskId, status: "running", note: "使用 check_background 查询结果" });
    }),
    readOnly(CHECK_BACKGROUND_DEFINITION, (i) => checkBackground(i.taskId)),
    ...taskSpecs,
    spec(COMPACT_DEF, () => compactExecute()),
    spec(TASK_DEFINITION, (i) => taskRunner
      ? taskRunner(i.prompt ?? "", i.description ?? "subtask")
      : "Error: task runner not initialized", { deferred: true }),
    readOnly(SKILL_LIST_DEFINITION, () => skillLoader?.listSkills() ?? "Error: skill system not initialized"),
    readOnly(SKILL_READ_DEFINITION, (i) => skillLoader?.getContent(i.name) ?? "Error: skill system not initialized"),
    spec(TOOL_SEARCH_DEFINITION, (i) => searchDeferredTools(String(i.query ?? "")), {
      isReadOnly: () => true,
      isConcurrencySafe: () => false,
    }),
    spec(MEMORY_SAVE_DEFINITION, memoryToolHandlers.memory_save, { deferred: true }),
    readOnly(MEMORY_LIST_DEFINITION, memoryToolHandlers.memory_list, { deferred: true }),
    readOnly(MEMORY_READ_DEFINITION, memoryToolHandlers.memory_read, { deferred: true }),
    spec(MEMORY_DELETE_DEFINITION, memoryToolHandlers.memory_delete, { deferred: true, isDestructive: () => true }),
    spec(PARTNER_CREATE_DEFINITION, teamToolHandlers.partner_create, { deferred: true }),
    readOnly(PARTNER_LIST_DEFINITION, teamToolHandlers.partner_list, { deferred: true }),
    spec(PARTNER_REMOVE_DEFINITION, teamToolHandlers.partner_remove, { deferred: true, isDestructive: () => true }),
    spec(PARTNER_SEND_DEFINITION, teamToolHandlers.partner_send, { deferred: true }),
    readOnly(PARTNER_READ_INBOX_DEFINITION, teamToolHandlers.partner_read_inbox, { deferred: true }),
    spec(PARTNER_BROADCAST_DEFINITION, teamToolHandlers.partner_broadcast, { deferred: true }),
    spec(PARTNER_SPAWN_DEFINITION, teamToolHandlers.partner_spawn, { deferred: true }),
  ];
}

function createMcpToolSpecs(): ToolSpec[] {
  return mcpDefinitions.map((definition) => spec(definition, (input) => {
    const name = functionName(definition);
    const dispatcher = mcpDispatchers.get(name);
    return dispatcher ? dispatcher(input) : `Error: unknown MCP tool '${name}'`;
  }, {
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
  }));
}

function getAllToolSpecs(): ToolSpec[] {
  return [...createBuiltInToolSpecs(), ...createMcpToolSpecs()];
}

function getActiveToolSpecs(): ToolSpec[] {
  return getAllToolSpecs().filter((tool) => !tool.deferred || activatedDeferredTools.has(tool.name));
}

function getToolSpec(name: string): ToolSpec | undefined {
  return getAllToolSpecs().find((tool) => tool.name === name);
}

function searchDeferredTools(query: string): string {
  const normalized = query.trim().toLowerCase();
  const deferred = getAllToolSpecs().filter((tool) => tool.deferred);
  const matches = deferred.filter((tool) => {
    const def = tool.definition as { function?: { description?: string } };
    const haystack = `${tool.name} ${def.function?.description ?? ""}`.toLowerCase();
    return !normalized || haystack.includes(normalized);
  });

  if (matches.length === 0) {
    return "No matching deferred tools found.";
  }

  for (const tool of matches) activatedDeferredTools.add(tool.name);

  return JSON.stringify(matches.map((tool) => tool.definition), null, 2);
}

export function getDeferredToolSummary(): string {
  const deferred = getAllToolSpecs().filter((tool) => tool.deferred);
  if (deferred.length === 0) return "";
  const names = deferred.map((tool) => tool.name).sort().join(", ");
  return [
    "## Deferred tools",
    "Some less common tools are hidden until needed to reduce tool schema tokens.",
    `Use \`tool_search\` to activate matching tools. Available deferred tool names: ${names}.`,
  ].join("\n");
}

export function resetDeferredToolActivations(): void {
  activatedDeferredTools.clear();
}

/**
 * 返回当前所有工具的定义列表（内置工具 + 动态注册的 MCP 工具）。
 * 每次调用都重新构建，确保 MCP 工具注册后能被包含进来。
 */
export function getDEFINITIONS(): object[] {
  return getActiveToolSpecs().map((tool) => tool.definition);
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

function persistLargeResult(toolName: string, output: string): string {
  const dir = join(getProjectAxonDir(), "tool-results");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const safeName = toolName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = join(dir, `${Date.now()}-${safeName}.txt`);
  writeFileSync(filePath, output, "utf-8");
  return filePath;
}

function processToolResult(tool: ToolSpec | undefined, toolName: string, output: string): string {
  const maxChars = tool?.maxResultSizeChars ?? DEFAULT_MAX_RESULT_SIZE_CHARS;
  if (output.length <= maxChars) return output;

  const filePath = output.length > TOOL_RESULT_PERSIST_THRESHOLD_CHARS
    ? persistLargeResult(toolName, output)
    : null;
  const keepEach = Math.max(1000, Math.floor((maxChars - 160) / 2));
  const truncated = [
    output.slice(0, keepEach),
    `[... truncated ${output.length - keepEach * 2} chars ...]`,
    ...(filePath ? [`Full result saved to: ${filePath}`] : []),
    output.slice(-keepEach),
  ];
  return truncated.join("\n\n");
}

export function isToolConcurrencySafe(name: string, input: ToolInput): boolean {
  const tool = getToolSpec(name);
  return tool?.isConcurrencySafe?.(input) ?? false;
}

/**
 * 工具调用分发器：根据工具名找到对应的执行函数并调用。
 * MCP 工具优先（动态注册），其次是内置工具。
 */
export async function dispatch(name: string, input: ToolInput): Promise<string> {
  const tool = getToolSpec(name);
  const decision = checkPermission(name, input, undefined, {
    isReadOnly: tool?.isReadOnly?.(input) ?? false,
    isDestructive: tool?.isDestructive?.(input) ?? false,
  });
  if (decision.action === "deny") {
    const output = `Permission denied: ${decision.message ?? name}`;
    auditToolCall({ toolName: name, input, decision, output });
    return output;
  }
  if (decision.action === "confirm") {
    const ok = await confirm(`⚠ 需要确认：${decision.message}`);
    if (!ok) {
      const output = "用户取消了执行。";
      auditToolCall({ toolName: name, input, decision, output });
      return output;
    }
  }

  let output: string;
  output = tool?.handler ? await tool.handler(input) : `Error: unknown tool '${name}'`;

  output = maskSecrets(output);
  output = processToolResult(tool, name, output);
  auditToolCall({ toolName: name, input, decision, output });
  return output;
}

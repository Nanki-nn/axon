import { DEFINITION as BASH_DEF, execute as bashExecute } from "./bash";
import {
  READ_DEFINITION, WRITE_DEFINITION, EDIT_DEFINITION, LIST_DEFINITION, SEARCH_DEFINITION,
  readFile, writeFile, editFile, listFiles, searchFiles,
} from "./files";
import { SkillLoader } from "../skills";

let skillLoader: SkillLoader | null = null;
// MCP dispatch registry: tool name → dispatch function
const mcpDispatchers = new Map<string, (input: Record<string, string>) => Promise<string>>();
const mcpDefinitions: object[] = [];

export function setSkillLoader(loader: SkillLoader): void {
  skillLoader = loader;
}

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

// Keep backward-compatible export that works before MCP is registered
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

export async function dispatch(name: string, input: ToolInput): Promise<string> {
  // MCP tools are registered dynamically
  if (mcpDispatchers.has(name)) {
    return mcpDispatchers.get(name)!(input);
  }

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

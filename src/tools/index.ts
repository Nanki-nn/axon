import { DEFINITION as BASH_DEF, execute as bashExecute } from "./bash";
import {
  READ_DEFINITION, WRITE_DEFINITION, EDIT_DEFINITION, LIST_DEFINITION, SEARCH_DEFINITION,
  readFile, writeFile, editFile, listFiles, searchFiles,
} from "./files";
import { SkillLoader } from "../skills";

let skillLoader: SkillLoader | null = null;

export function setSkillLoader(loader: SkillLoader): void {
  skillLoader = loader;
}

const LOAD_SKILL_DEFINITION = {
  type: "function" as const,
  function: {
    name: "load_skill",
    description: "Load the full instructions for a named skill. Call this before tackling a task that matches one of the available skills.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name to load" },
      },
      required: ["name"],
    },
  },
};

export const DEFINITIONS = [
  BASH_DEF,
  READ_DEFINITION,
  WRITE_DEFINITION,
  EDIT_DEFINITION,
  LIST_DEFINITION,
  SEARCH_DEFINITION,
  LOAD_SKILL_DEFINITION,
];

type ToolInput = Record<string, string>;

export async function dispatch(name: string, input: ToolInput): Promise<string> {
  switch (name) {
    case "bash":         return bashExecute(input.command);
    case "read_file":    return readFile(input.path);
    case "write_file":   return writeFile(input.path, input.content);
    case "edit_file":    return editFile(input.path, input.old_string, input.new_string);
    case "list_files":   return listFiles(input.pattern);
    case "search_files": return searchFiles(input.pattern, input.path ?? ".");
    case "load_skill":   return skillLoader?.getContent(input.name) ?? "Error: skill system not initialized";
    default:             return `Error: unknown tool '${name}'`;
  }
}

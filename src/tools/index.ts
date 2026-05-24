import { DEFINITION as BASH_DEF, execute as bashExecute } from "./bash";
import {
  READ_DEFINITION, WRITE_DEFINITION, EDIT_DEFINITION, LIST_DEFINITION, SEARCH_DEFINITION,
  readFile, writeFile, editFile, listFiles, searchFiles,
} from "./files";

export const DEFINITIONS = [
  BASH_DEF,
  READ_DEFINITION,
  WRITE_DEFINITION,
  EDIT_DEFINITION,
  LIST_DEFINITION,
  SEARCH_DEFINITION,
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
    default:             return `Error: unknown tool '${name}'`;
  }
}

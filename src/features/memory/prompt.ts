import { getStructuredMemoryDir } from "./paths";
import { loadMemoryIndex } from "./store";

export function buildMemoryPromptSection(): string {
  const memoryDir = getStructuredMemoryDir();
  const index = loadMemoryIndex();

  return `## Structured Memory
You have a persistent, project-scoped file memory system at \`${memoryDir}\`.

Memory types:
- user: user's role, preferences, knowledge level, communication style
- feedback: corrections and guidance from the user, including why and how to apply it
- project: ongoing goals, decisions, constraints, and durable project context
- reference: pointers to external resources, URLs, dashboards, tools, and docs

Use \`memory_save\` when the user explicitly asks you to remember something, gives durable feedback, sets a future preference, makes a lasting project decision, or shares a reference that should be available later.

Do not save code details, git history, facts already present in project docs, or ephemeral task progress. Read current code instead of relying on memory for implementation details.

The MEMORY.md index is maintained automatically.
${index ? `\nCurrent memory index:\n${index}` : "\nNo structured memories saved yet."}`;
}

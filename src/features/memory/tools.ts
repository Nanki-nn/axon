import { deleteMemory, listMemories, readMemory, saveMemory } from "./store";
import { MemoryType } from "./types";

const MEMORY_TYPES = ["user", "feedback", "project", "reference"];

function validType(type: unknown): type is MemoryType {
  return typeof type === "string" && MEMORY_TYPES.includes(type);
}

export const MEMORY_SAVE_DEFINITION = {
  type: "function" as const,
  function: {
    name: "memory_save",
    description: "Save a durable structured memory for this project.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short memory name" },
        description: { type: "string", description: "One-line description used for semantic recall" },
        type: { type: "string", enum: MEMORY_TYPES, description: "Memory category" },
        content: { type: "string", description: "Full memory content" },
      },
      required: ["name", "description", "type", "content"],
    },
  },
};

export const MEMORY_LIST_DEFINITION = {
  type: "function" as const,
  function: {
    name: "memory_list",
    description: "List saved structured memories for this project.",
    parameters: { type: "object", properties: {}, required: [] },
  },
};

export const MEMORY_READ_DEFINITION = {
  type: "function" as const,
  function: {
    name: "memory_read",
    description: "Read a structured memory file by filename.",
    parameters: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Memory filename, e.g. project_release_goals.md" },
      },
      required: ["filename"],
    },
  },
};

export const MEMORY_DELETE_DEFINITION = {
  type: "function" as const,
  function: {
    name: "memory_delete",
    description: "Delete a structured memory file by filename.",
    parameters: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Memory filename to delete" },
      },
      required: ["filename"],
    },
  },
};

function memorySave(input: Record<string, any>): string {
  const { name, description, type, content } = input;
  if (!name || !description || !content || !validType(type)) {
    return "Error: name, description, valid type, and content are required.";
  }

  const filename = saveMemory({ name, description, type, content });
  return `Memory saved: ${filename}`;
}

function memoryList(): string {
  const memories = listMemories();
  if (memories.length === 0) return "No structured memories saved.";
  return memories
    .map((memory) => `- [${memory.type}] ${memory.filename}: ${memory.name} — ${memory.description}`)
    .join("\n");
}

function memoryRead(input: Record<string, any>): string {
  const content = readMemory(input.filename);
  return content ?? `Error: memory not found: ${input.filename}`;
}

function memoryDelete(input: Record<string, any>): string {
  return deleteMemory(input.filename)
    ? `Memory deleted: ${input.filename}`
    : `Error: memory not found: ${input.filename}`;
}

export const memoryToolHandlers = {
  memory_save: memorySave as (input: Record<string, any>) => string,
  memory_list: memoryList as (input: Record<string, any>) => string,
  memory_read: memoryRead as (input: Record<string, any>) => string,
  memory_delete: memoryDelete as (input: Record<string, any>) => string,
};

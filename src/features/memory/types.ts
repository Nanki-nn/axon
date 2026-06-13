export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface MemoryEntry {
  name: string;
  description: string;
  type: MemoryType;
  filename: string;
  content: string;
}

export interface MemoryHeader {
  filename: string;
  filePath: string;
  mtimeMs: number;
  description: string | null;
  type: MemoryType | undefined;
}

export interface RelevantMemory {
  path: string;
  content: string;
  mtimeMs: number;
  header: string;
}

export type SideQueryFn = (system: string, userMessage: string) => Promise<string>;

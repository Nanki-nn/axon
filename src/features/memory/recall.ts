import { readFileSync, readdirSync } from "fs";
import { getStructuredMemoryDir } from "./paths";
import { formatMemoryManifest, scanMemoryHeaders } from "./store";
import { RelevantMemory, SideQueryFn } from "./types";

const MAX_MEMORY_BYTES_PER_FILE = 4096;
export const MAX_SESSION_MEMORY_BYTES = 60 * 1024;

const SELECT_MEMORIES_PROMPT = `You are selecting memories that will be useful to an AI assistant as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a JSON object with a "selected_memories" array of filenames for the memories that will clearly be useful (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful, do not include it.
- If no memories would clearly be useful, return an empty array.`;

function isQuerySubstantial(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;

  const cjkMatches = trimmed.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g);
  if (cjkMatches && cjkMatches.length >= 2) return true;

  return /\s/.test(trimmed);
}

export function memoryAge(mtimeMs: number): string {
  const days = Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

export function memoryFreshnessWarning(mtimeMs: number): string {
  const days = Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000));
  if (days <= 1) return "";
  return `This memory is ${days} days old. Memories are point-in-time observations, not live state. Verify against current code before asserting as fact.`;
}

export async function selectRelevantMemories(
  query: string,
  sideQuery: SideQueryFn,
  alreadySurfaced: Set<string>,
): Promise<RelevantMemory[]> {
  const headers = scanMemoryHeaders();
  const candidates = headers.filter((header) => !alreadySurfaced.has(header.filePath));
  if (candidates.length === 0) return [];

  const text = await sideQuery(
    SELECT_MEMORIES_PROMPT,
    `Query: ${query}\n\nAvailable memories:\n${formatMemoryManifest(candidates)}`,
  );

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];

  const parsed = JSON.parse(jsonMatch[0]) as { selected_memories?: string[] };
  const selectedFilenames = new Set(parsed.selected_memories || []);
  const selected = candidates.filter((header) => selectedFilenames.has(header.filename));

  return selected.slice(0, 5).map((header) => {
    let content = readFileSync(header.filePath, "utf-8");
    if (Buffer.byteLength(content) > MAX_MEMORY_BYTES_PER_FILE) {
      content = content.slice(0, MAX_MEMORY_BYTES_PER_FILE) +
        "\n\n[... truncated, memory file too large ...]";
    }

    const freshness = memoryFreshnessWarning(header.mtimeMs);
    const headerText = freshness
      ? `${freshness}\n\nMemory: ${header.filePath}:`
      : `Memory (saved ${memoryAge(header.mtimeMs)}): ${header.filePath}:`;

    return { path: header.filePath, content, mtimeMs: header.mtimeMs, header: headerText };
  });
}

export async function recallMemories(
  query: string,
  sideQuery: SideQueryFn,
  alreadySurfaced: Set<string>,
  sessionMemoryBytes: number,
): Promise<RelevantMemory[]> {
  if (!isQuerySubstantial(query)) return [];
  if (sessionMemoryBytes >= MAX_SESSION_MEMORY_BYTES) return [];

  const hasMemories = readdirSync(getStructuredMemoryDir())
    .some((file) => file.endsWith(".md") && file !== "MEMORY.md");
  if (!hasMemories) return [];

  try {
    return await selectRelevantMemories(query, sideQuery, alreadySurfaced);
  } catch {
    return [];
  }
}

export function formatMemoriesForInjection(memories: RelevantMemory[]): string {
  return memories
    .map((memory) => `<system-reminder>\n${memory.header}\n\n${memory.content}\n</system-reminder>`)
    .join("\n\n");
}

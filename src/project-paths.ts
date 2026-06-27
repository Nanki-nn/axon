import { existsSync, mkdirSync } from "fs";
import { join } from "path";

const PROJECT_AXON_DIR = ".axon";

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function projectPath(...parts: string[]): string {
  return join(process.cwd(), PROJECT_AXON_DIR, ...parts);
}

function legacyPath(...parts: string[]): string {
  return join(process.cwd(), ...parts);
}

export function getProjectAxonDir(): string {
  return ensureDir(projectPath());
}

export function getProjectConfigPath(): string {
  return projectPath("config.json");
}

export function getLegacyProjectConfigPath(): string {
  return legacyPath("axon.config.json");
}

export function getProjectConfigCandidates(): string[] {
  return [getProjectConfigPath(), getLegacyProjectConfigPath()];
}

export function getSkillsDirs(): string[] {
  return [projectPath("skills"), legacyPath(".agents", "skills")];
}

export function getTasksDir(): string {
  return process.env.AXON_TASKS_DIR || projectPath("tasks");
}

export function getTeamsDir(): string {
  return process.env.AXON_TEAMS_DIR || projectPath("teams");
}

export function getTranscriptsDir(): string {
  return projectPath("transcripts");
}

export function getSessionsDir(): string {
  return projectPath("sessions");
}

export function getDebugLogPath(): string {
  return projectPath("debug-messages.log");
}

export function getStructuredMemoryDirPath(): string {
  return process.env.AXON_MEMORY_DIR || projectPath("memory", "structured");
}

export function getDreamMemoryDir(): string {
  return projectPath("memory", "dream");
}

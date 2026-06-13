import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { TeammateConfig } from "./types";

const DEFAULT_TEAMS_DIR = join(process.cwd(), ".agents", "teams");

export const TEAMS_DIR = DEFAULT_TEAMS_DIR;
export const INBOXES_DIR = join(DEFAULT_TEAMS_DIR, "inboxes");
export const CONFIG_FILE = join(DEFAULT_TEAMS_DIR, "team.json");

export function getTeamsDir(): string {
  return process.env.AXON_TEAMS_DIR || DEFAULT_TEAMS_DIR;
}

export function getInboxesDir(): string {
  return join(getTeamsDir(), "inboxes");
}

export function getConfigFile(): string {
  return join(getTeamsDir(), "team.json");
}

export function ensureTeamDirs(): void {
  const inboxesDir = getInboxesDir();
  if (!existsSync(inboxesDir)) {
    mkdirSync(inboxesDir, { recursive: true });
  }
}

export function loadTeam(): TeammateConfig[] {
  try {
    ensureTeamDirs();
    const configFile = getConfigFile();
    if (existsSync(configFile)) {
      return JSON.parse(readFileSync(configFile, "utf-8")) as TeammateConfig[];
    }
  } catch {
    // 配置损坏时降级为空团队，避免阻塞主流程。
  }
  return [];
}

export function saveTeam(team: TeammateConfig[]): void {
  try {
    ensureTeamDirs();
    writeFileSync(getConfigFile(), JSON.stringify(team, null, 2), "utf-8");
  } catch {
    // 写入失败不抛出，工具层会返回可读错误。
  }
}

export function findTeammate(name: string): TeammateConfig | undefined {
  return loadTeam().find((t) => t.name === name);
}

export function inboxPath(name: string): string {
  ensureTeamDirs();
  return join(getInboxesDir(), `${name}.jsonl`);
}

export function removeInbox(name: string): void {
  const filePath = inboxPath(name);
  if (existsSync(filePath)) {
    rmSync(filePath);
  }
}

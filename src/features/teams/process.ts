import { ChildProcess, spawn } from "child_process";
import { logger } from "../../logger";
import { TeammateConfig } from "./types";

const teammateProcesses = new Map<string, ChildProcess>();

function buildSpawnCommand(entryPoint: string, name: string): { command: string; args: string[] } {
  if (entryPoint.endsWith(".ts")) {
    return { command: "npx", args: ["tsx", entryPoint, "--teammate", name] };
  }
  return { command: process.execPath, args: [entryPoint, "--teammate", name] };
}

/**
 * 启动一个队友子进程。
 * 队友通过 --teammate 进入轮询模式，具体角色指令走环境变量传递。
 */
export function spawnTeammate(config: TeammateConfig): ChildProcess | null {
  const entryPoint = process.argv[1];
  if (!entryPoint) return null;

  const instruction = `你是一个 AI 助手，作为 "${config.name}" 团队成员。你的职责：${config.instruction}`;
  const { command, args } = buildSpawnCommand(entryPoint, config.name);
  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AXON_TEAMMATE: "1",
      AXON_TEAMMATE_NAME: config.name,
      AXON_TEAMMATE_INSTRUCTION: instruction,
    },
  });

  child.stdout?.on("data", (data: Buffer) => {
    const text = data.toString().trim();
    if (text) logger.info("teams", `[${config.name}] ${text}`);
  });

  child.stderr?.on("data", (data: Buffer) => {
    const text = data.toString().trim();
    if (text) logger.error("teams", `[${config.name}] ${text}`);
  });

  child.on("exit", (code) => {
    logger.info("teams", `队友 "${config.name}" 进程退出，退出码: ${code}`);
    teammateProcesses.delete(config.name);
  });

  child.on("error", (err) => {
    logger.error("teams", `队友 "${config.name}" 启动失败: ${err.message}`);
    teammateProcesses.delete(config.name);
  });

  teammateProcesses.set(config.name, child);
  return child;
}

export function isTeammateRunning(name: string): boolean {
  return teammateProcesses.has(name);
}

export function killTeammate(name: string): void {
  const proc = teammateProcesses.get(name);
  if (proc) {
    proc.kill();
    teammateProcesses.delete(name);
  }
}

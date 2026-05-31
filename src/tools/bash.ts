import { execSync } from "child_process";
import chalk from "chalk";
import { getMode } from "../mode";

export const DEFINITION = {
  type: "function" as const,
  function: {
    name: "bash",
    description:
      "Execute a bash command in the current working directory. " +
      "Use for running tests, installing packages, git operations, etc.",
    parameters: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "The bash command to execute" },
      },
      required: ["command"],
    },
  },
};

// 需要二次确认的危险命令特征
const DANGEROUS = [
  "rm -rf", "sudo rm", "dd if=", "> /dev/", "mkfs", ":(){:|:&};:",
  "curl | bash", "curl|bash", "wget -O- |", "wget -qO- |",
  "wget -O - |", "| bash", "| sh",
];

/** 向用户提问，返回是否确认（y 开头视为 yes） */
export function confirm(question: string): Promise<boolean> {
  process.stdout.write(question + " (y/N) ");
  return new Promise((resolve) => {
    process.stdin.setEncoding("utf-8");
    process.stdin.once("data", (data) => {
      resolve(data.toString().trim().toLowerCase().startsWith("y"));
    });
  });
}

export async function execute(command: string): Promise<string> {
  console.log(chalk.yellow(`\n$ ${command}`));

  // yolo 模式跳过所有确认，其他模式对危险命令弹出提示
  if (getMode() !== "yolo" && DANGEROUS.some((p) => command.includes(p))) {
    const ok = await confirm(chalk.red("⚠ 危险命令，确认执行？"));
    if (!ok) return "用户取消了执行。";
  }

  try {
    const output = execSync(command, {
      encoding: "utf-8",
      timeout: 60_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output.trim() || "(no output)";
  } catch (err: any) {
    const combined = ((err.stdout ?? "") + (err.stderr ?? "")).trim();
    return combined
      ? `${combined}\n[exit code ${err.status ?? 1}]`
      : `[exit code ${err.status ?? 1}]`;
  }
}

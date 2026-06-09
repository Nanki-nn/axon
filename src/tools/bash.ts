import { execSync } from "child_process";
import chalk from "chalk";
import { getMode } from "../mode";

/**
 * bash 工具 
 * 注意：这个工具非常强大且危险，使用时请务必小心，尤其是在生产环境中。
 * 建议在开发和测试环境中使用，避免在生产环境中执行不受信任的命令。
 * 工具会对一些常见的危险命令进行检测，并要求用户确认，除非处于 "yolo" 模式。
 *  * 例如，创建一个 `deploy.sh` 脚本来处理部署流程，然后使用 `bash deploy.sh` 来执行它。
 * 这个工具的输出会捕获命令的标准输出和标准错误，并返回给调用者。对于长时间运行的命令，建议使用 `background` 工具来避免阻塞主线程。
 */


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

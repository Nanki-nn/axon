import { execSync, spawnSync } from "child_process";
import chalk from "chalk";

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

const DANGEROUS = ["rm -rf", "sudo rm", "dd if=", "> /dev/", "mkfs", ":(){:|:&};:"];

function confirm(question: string): Promise<boolean> {
  // Inline confirm without extra deps
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

  if (DANGEROUS.some((p) => command.includes(p))) {
    const ok = await confirm(chalk.red("This looks dangerous. Execute?"));
    if (!ok) return "Command cancelled by user.";
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

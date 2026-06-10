import chalk from "chalk";
import { readFileSync } from "fs";
import { join } from "path";

let _version: string | undefined;

function getVersion(): string {
  if (!_version) {
    try {
      const pkg = JSON.parse(
        readFileSync(join(__dirname, "..", "package.json"), "utf-8")
      );
      _version = pkg.version || "0.0.0";
    } catch {
      _version = "1.0.0";
    }
  }
  return _version!;
}

const AXON_ART = [
  "█████╗ ██╗  ██╗ ██████╗ ███╗   ██╗",
  "██╔══██╗╚██╗██╔╝██╔═══██╗████╗  ██║",
  "███████║ ╚███╔╝ ██║   ██║██╔██╗ ██║",
  "██╔══██║ ██╔██╗ ██║   ██║██║╚██╗██║",
  "██║  ██║██╔╝ ██╗╚██████╔╝██║ ╚████║",
  "╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝",
];

/**
 * 在终端中打印 Axon 启动标识 — ANSI Shadow 风格艺术字 + 版本号。
 */
export function printLogo(): void {
  const logo = AXON_ART.map((line) => chalk.cyan(line)).join("\n");
  const tagline = `${chalk.dim("v" + getVersion())}  ${chalk.gray("·")}  ${chalk.dim("AI coding assistant, right in your terminal")}`;

  console.log(`\n${logo}\n\n  ${tagline}\n`);
}

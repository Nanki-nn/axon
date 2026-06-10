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

export interface LogoInfo {
  model?: string;
  skillNames?: string[];
  hasAgentsContext?: boolean;
  hasMemory?: boolean;
}

/** 截断技能名列表以适应最大宽度，超出部分显示为 "+N more" */
function truncateSkills(names: string[], maxWidth: number): string {
  if (names.length === 0) return "";
  let result = names[0];
  for (let i = 1; i < names.length; i++) {
    const next = `, ${names[i]}`;
    const remaining = names.length - i;
    if ((result + next + ` +${remaining} more`).length > maxWidth) {
      return result + ` +${remaining} more`;
    }
    result += next;
  }
  return result;
}

const AXON_ART = [
  "█████╗ ██╗  ██╗ ██████╗ ███╗   ██╗",
  "██╔══██╗╚██╗██╔╝██╔═══██╗████╗  ██║",
  "███████║ ╚███╔╝ ██║   ██║██╔██╗ ██║",
  "██╔══██║ ██╔██╗ ██║   ██║██║╚██╗██║",
  "██║  ██║██╔╝ ██╗╚██████╔╝██║ ╚████║",
  "╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝",
];

/** 以卡片样式打印 Axon 启动标识 */
export function printLogo(info: LogoInfo = {}): void {
  const ver = `v${getVersion()}`;
  const rightRaw = [
    "",
    "",
    info.model ? `model: ${info.model}` : "",
    info.skillNames?.length ? `skill: ${truncateSkills(info.skillNames, 15)}` : "",
    "",
    "",
  ];

  // 规范化艺术字宽度（ANSI Shadow 字体每行宽度可能不同）
  const artLines = AXON_ART.map((a) => "  " + a);
  const artWidth = Math.max(...artLines.map((a) => a.length));

  const cyan = chalk.cyan;
  const dim = chalk.dim;
  const inner = 70;  // 卡片内部宽度（不含左右边框）
  const rightW = 24; // 右侧信息列宽度
  const gapW = inner - 1 - artWidth - rightW - 1; // 左侧留空 + 艺术字 + 右侧留空 后剩余的间距

  const lines: string[] = [];

  // 上边框（左角挂版本号）
  const versionLabel = `─ ${ver} ─`;
  lines.push(`${cyan("╭")}${cyan(versionLabel)}${cyan("─".repeat(inner - versionLabel.length))}${cyan("╮")}`);

  // 空行
  lines.push(`${cyan("│")}${" ".repeat(inner)}${cyan("│")}`);

  // 六行内容（AXON 艺术字 + 右侧元数据）
  for (let i = 0; i < 6; i++) {
    const left = artLines[i].padEnd(artWidth);
    const right = ((rightRaw[i] || "").padEnd(rightW)).slice(0, rightW);
    lines.push(cyan("│") + " " + cyan(left) + " ".repeat(gapW) + dim(right) + " " + cyan("│"));
  }

  // 空行
  lines.push(`${cyan("│")}${" ".repeat(inner)}${cyan("│")}`);

  // 下边框
  lines.push(`${cyan("╰")}${cyan("─".repeat(inner))}${cyan("╯")}`);

  console.log(`\n${lines.join("\n")}\n`);
}

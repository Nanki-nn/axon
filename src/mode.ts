/**
 * 执行模式管理
 *
 * 三种模式定义了 agent 执行工具时的安全边界：
 * - yolo：完全自主，跳过所有确认（适合信任环境）
 * - default：危险操作需要确认，普通操作直接执行
 * - plan：只读规划模式，阻止写入和 shell 执行
 * - accept-edits：自动允许文件编辑，仍确认危险 shell
 * - dont-ask：非交互模式，所有需要确认的操作自动拒绝
 */
export type Mode = "yolo" | "default" | "plan" | "accept-edits" | "dont-ask";

let current: Mode = "default";

export function setMode(mode: Mode): void {
  current = mode;
}

export function getMode(): Mode {
  return current;
}

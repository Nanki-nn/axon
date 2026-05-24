/**
 * 执行模式管理
 *
 * 三种模式定义了 agent 执行工具时的安全边界：
 * - yolo：完全自主，跳过所有确认（适合信任环境）
 * - default：危险命令需要确认，普通操作直接执行
 * - plan：每轮工具调用前展示完整计划，等用户确认后再执行
 */
export type Mode = "yolo" | "default" | "plan";

let current: Mode = "default";

export function setMode(mode: Mode): void {
  current = mode;
}

export function getMode(): Mode {
  return current;
}

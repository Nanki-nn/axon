import { appendFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";

// ── 日志级别 ──
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4,
}

const LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "DEBUG",
  [LogLevel.INFO]: "INFO",
  [LogLevel.WARN]: "WARN",
  [LogLevel.ERROR]: "ERROR",
  [LogLevel.SILENT]: "SILENT",
};

// ── 颜色 ──
const COLORS: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "\x1b[36m", // 青色
  [LogLevel.INFO]: "\x1b[32m", // 绿色
  [LogLevel.WARN]: "\x1b[33m", // 黄色
  [LogLevel.ERROR]: "\x1b[31m", // 红色
  [LogLevel.SILENT]: "",
};
const RESET = "\x1b[0m";
const GRAY = "\x1b[90m";

// ── 配置 ──
let globalLevel: LogLevel = LogLevel.INFO;
let logFile: string | null = null;

export function configureLogger(opts: { level?: LogLevel; file?: string }) {
  if (opts.level !== undefined) globalLevel = opts.level;
  if (opts.file !== undefined) {
    const dir = dirname(opts.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    logFile = opts.file;
  }
}

export function getLogLevel(): LogLevel {
  return globalLevel;
}

// ── 核心日志函数 ──
function log(level: LogLevel, module: string, ...args: unknown[]) {
  if (level < globalLevel) return;

  const now = new Date().toISOString();
  const msg = args
    .map((a) => (typeof a === "object" ? JSON.stringify(a, null, 0) : String(a)))
    .join(" ");

  const prefix = `[${now}] [${LEVEL_NAMES[level]}] [${module}]`;
  const line = `${prefix} ${msg}`;

  // 终端输出（带颜色）
  if (level >= globalLevel && globalLevel !== LogLevel.SILENT) {
    const color = COLORS[level];
    const ts = GRAY + now.slice(0, 19).replace("T", " ") + RESET;
    const lvl = color + LEVEL_NAMES[level].padEnd(5) + RESET;
    const mod = GRAY + module + RESET;
    console.error(`${ts} ${lvl} ${mod} ${msg}`);
  }

  // 文件输出（纯文本）
  if (logFile) {
    try {
      appendFileSync(logFile, line + "\n", "utf-8");
    } catch {
      // 日志文件写入失败不抛出
    }
  }
}

// ── 导出接口 ──
export const logger = {
  debug: (module: string, ...args: unknown[]) => log(LogLevel.DEBUG, module, ...args),
  info: (module: string, ...args: unknown[]) => log(LogLevel.INFO, module, ...args),
  warn: (module: string, ...args: unknown[]) => log(LogLevel.WARN, module, ...args),
  error: (module: string, ...args: unknown[]) => log(LogLevel.ERROR, module, ...args),
};

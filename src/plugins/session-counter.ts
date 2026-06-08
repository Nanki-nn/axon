import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { AxonPlugin } from "../hooks";

// 元数据文件路径（~/.axon/memory/.meta.json）
// 存储跨会话的统计信息：会话总数、上次 Dream 时间戳
const META_DIR = path.join(os.homedir(), ".axon", "memory");
const META_FILE = path.join(META_DIR, ".meta.json");

interface Meta {
  sessionCount: number;  // 累计会话次数
  lastDreamAt: string;   // 上次 Dream 整合的 ISO 时间戳
}

/** 读取元数据，文件不存在时返回初始值 */
function readMeta(): Meta {
  try {
    return JSON.parse(fs.readFileSync(META_FILE, "utf-8")) as Meta;
  } catch {
    // 首次运行或文件损坏时，用零值初始化
    return { sessionCount: 0, lastDreamAt: new Date(0).toISOString() };
  }
}

/** 写入元数据，确保目录存在 */
function writeMeta(meta: Meta): void {
  fs.mkdirSync(META_DIR, { recursive: true });
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), "utf-8");
}

/** 获取当前累计会话次数 */
export function getSessionCount(): number {
  return readMeta().sessionCount;
}

/** 获取上次 Dream 整合的时间 */
export function getLastDreamAt(): Date {
  return new Date(readMeta().lastDreamAt);
}

/** 会话计数 +1 并持久化 */
export function incrementSessionCount(): void {
  const meta = readMeta();
  meta.sessionCount += 1;
  writeMeta(meta);
}

/** 将上次 Dream 时间更新为当前时间（Dream 完成后调用） */
export function resetDreamTimestamp(): void {
  const meta = readMeta();
  meta.lastDreamAt = new Date().toISOString();
  writeMeta(meta);
}

/**
 * SessionCounterPlugin：在每次会话结束时递增计数器。
 * 注意：AutoDreamPlugin 也会调用 incrementSessionCount，
 * 两者都注册时计数会叠加——实际使用中只需注册 AutoDreamPlugin。
 */
export class SessionCounterPlugin implements AxonPlugin {
  async onSessionEnd(): Promise<void> {
    incrementSessionCount();
  }
}

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { AxonPlugin } from "../hooks";

const META_DIR = path.join(os.homedir(), ".axon", "memory");
const META_FILE = path.join(META_DIR, ".meta.json");

interface Meta {
  sessionCount: number;
  lastDreamAt: string;
}

function readMeta(): Meta {
  try {
    return JSON.parse(fs.readFileSync(META_FILE, "utf-8")) as Meta;
  } catch {
    return { sessionCount: 0, lastDreamAt: new Date(0).toISOString() };
  }
}

function writeMeta(meta: Meta): void {
  fs.mkdirSync(META_DIR, { recursive: true });
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), "utf-8");
}

export function getSessionCount(): number {
  return readMeta().sessionCount;
}

export function getLastDreamAt(): Date {
  return new Date(readMeta().lastDreamAt);
}

export function incrementSessionCount(): void {
  const meta = readMeta();
  meta.sessionCount += 1;
  writeMeta(meta);
}

export function resetDreamTimestamp(): void {
  const meta = readMeta();
  meta.lastDreamAt = new Date().toISOString();
  writeMeta(meta);
}

export class SessionCounterPlugin implements AxonPlugin {
  async onSessionEnd(): Promise<void> {
    incrementSessionCount();
  }
}

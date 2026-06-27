import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import {
  appendSessionSnapshot,
  createSessionId,
  latestSessionId,
  loadSessionMessages,
  sessionPath,
} from "../session-store";

const TEST_AXON_DIR = join(process.cwd(), ".axon");

function clean(): void {
  const sessionsDir = join(TEST_AXON_DIR, "sessions");
  if (existsSync(sessionsDir)) rmSync(sessionsDir, { recursive: true, force: true });
}

describe("session store", () => {
  beforeEach(clean);
  afterEach(clean);

  it("appends snapshots and loads the latest valid one", () => {
    const id = createSessionId();
    appendSessionSnapshot(id, [{ role: "user", content: "one" }]);
    appendSessionSnapshot(id, [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
    ]);
    appendFileSync(sessionPath(id), "{partial", "utf-8");

    const messages = loadSessionMessages(id);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ role: "assistant", content: "two" });
  });

  it("finds the latest session id", () => {
    appendSessionSnapshot("older", [{ role: "user", content: "old" }]);
    appendSessionSnapshot("newer", [{ role: "user", content: "new" }]);

    expect(latestSessionId()).toBe("newer");
  });
});

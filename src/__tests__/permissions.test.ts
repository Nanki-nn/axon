import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { checkPermission, isDangerousCommand, maskSecrets, resetPermissionCache } from "../permissions";
import { setMode } from "../mode";

const TEST_AXON_DIR = join(process.cwd(), ".tmp", "permission-test");
const TEST_SETTINGS = join(TEST_AXON_DIR, "settings.json");

function reset(): void {
  if (existsSync(TEST_AXON_DIR)) rmSync(TEST_AXON_DIR, { recursive: true, force: true });
  delete process.env.AXON_PERMISSION_SETTINGS_PATHS;
  resetPermissionCache();
  setMode("default");
}

describe("permissions", () => {
  afterEach(reset);

  it("识别危险 shell 命令并要求确认", () => {
    expect(isDangerousCommand("rm -rf dist")).toBe(true);
    expect(checkPermission("bash", { command: "rm -rf dist" }).action).toBe("confirm");
    expect(checkPermission("bash", { command: "npm test" }).action).toBe("allow");
  });

  it("plan 模式阻止写入和 shell", () => {
    setMode("plan");
    expect(checkPermission("read_file", { path: "README.md" }).action).toBe("allow");
    expect(checkPermission("write_file", { path: "tmp.txt" }).action).toBe("deny");
    expect(checkPermission("bash", { command: "npm test" }).action).toBe("deny");
  });

  it("dont-ask 模式自动拒绝需要确认的操作", () => {
    setMode("dont-ask");
    const decision = checkPermission("bash", { command: "git push --force" });
    expect(decision.action).toBe("deny");
    expect(decision.message).toContain("Auto-denied");
  });

  it("accept-edits 模式允许文件编辑但仍确认危险 shell", () => {
    setMode("accept-edits");
    expect(checkPermission("write_file", { path: "new-file.txt" }).action).toBe("allow");
    expect(checkPermission("bash", { command: "sudo rm -rf /tmp/x" }).action).toBe("confirm");
  });

  it("权限规则中 deny 优先于 allow", () => {
    mkdirSync(TEST_AXON_DIR, { recursive: true });
    writeFileSync(TEST_SETTINGS, JSON.stringify({
      permissions: {
        allow: ["bash(npm*)"],
        deny: ["bash(npm publish*)"],
      },
    }));
    process.env.AXON_PERMISSION_SETTINGS_PATHS = TEST_SETTINGS;
    resetPermissionCache();

    expect(checkPermission("bash", { command: "npm test" }).action).toBe("allow");
    expect(checkPermission("bash", { command: "npm publish --access public" }).action).toBe("deny");
  });

  it("mask 输出中的常见 secret", () => {
    const masked = maskSecrets("apiKey: sk-1234567890abcdef TOKEN=secret-value");
    expect(masked).not.toContain("sk-1234567890abcdef");
    expect(masked).toContain("[REDACTED]");
  });
});
